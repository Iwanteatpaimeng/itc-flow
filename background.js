/* MV3 coordinator. Timers and media live in the page, never in the popup. */
importScripts("shared.js");
const { normalizeSettings } = StudyShared;
const sessions = new Map();
const queues = new Map();
const delayedAdvances = new Map();
const probeTimers = new Map();
const embeddedReady = new Map();
const embeddedTimers = new Map();
let settings = normalizeSettings();
const SESSION_PREFIX = "itc:tab:";
const BEHAVIOR_VERSION = 12;
const DETECTION_TIMEOUT_MS = 15000;
const ready = (async () => {
  const [local, stored] = await Promise.all([chrome.storage.local.get("settings"), chrome.storage.session.get(null)]);
  settings = normalizeSettings(local.settings);
  // Discard the former reading-completion timer, never turn it into a scroll interval.
  await chrome.storage.local.set({ settings });
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(SESSION_PREFIX) || !Number.isInteger(value?.tabId)) continue;
    if (value.behaviorVersion !== BEHAVIOR_VERSION) {
      Object.assign(value, { behaviorVersion: BEHAVIOR_VERSION, running: false, phase: "paused", nextAt: null,
        pauseNextRemaining: null, pauseFrom: null, checkpoint: null, remainingSeconds: 0, scroll: null, flow: null, embedded: {},
        detail: "已修复误滚目录的问题，请刷新课程页面后开始，插件只滚动正文及内嵌文档。" });
      await chrome.storage.session.set({ [key]: value });
    }
    sessions.set(value.tabId, value);
  }
  await chrome.alarms.create("itc-watchdog", { periodInMinutes: 0.5 });
})();

function serialize(tabId, operation) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => ready).then(operation);
  queues.set(tabId, next);
  void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}
function originPattern(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/*` : null;
  } catch { return null; }
}
function publicStatus(session) {
  if (!session) return null;
  const fields = ["phase", "running", "taskType", "title", "detail", "remainingSeconds", "elapsedSeconds",
    "videoCurrent", "videoDuration", "scroll", "flow", "completedCount", "history", "updatedAt", "url", "nextAt"];
  const status = Object.fromEntries(fields.map(key => [key, session[key] ?? null]));
  if (session.nextAt) status.remainingSeconds = Math.max(0, Math.ceil((session.nextAt - Date.now()) / 1000));
  return status;
}
function taskIdentity(session, frameId, key) {
  return `${session.taskContext ? `${session.taskContext}:` : ""}${frameId}:${key}`;
}
async function save(session) {
  session.updatedAt = Date.now();
  sessions.set(session.tabId, session);
  await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.tabId}`]: session });
  void chrome.runtime.sendMessage({ type: "STATUS_UPDATED", tabId: session.tabId, status: publicStatus(session) }).catch(() => {});
}
async function send(tabId, frameId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId }); }
  catch { return null; }
}
function clearAdvance(tabId) {
  clearTimeout(delayedAdvances.get(tabId));
  delayedAdvances.delete(tabId);
}
async function registerOrigin(pattern) {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.some(script => script.matches?.includes(pattern))) return;
  await chrome.scripting.registerContentScripts([{
    id: `itc-${crypto.randomUUID()}`, matches: [pattern], js: ["shared.js", "content.js"], allFrames: true,
    matchOriginAsFallback: true, runAt: "document_idle", persistAcrossSessions: true
  }]);
}
async function inject(tabId, knownFrameIds = []) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["shared.js", "content.js"] });
    return [...new Set([0, ...results.map(result => result.frameId)])];
  } catch (error) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["shared.js", "content.js"] });
      // A newly granted document may share a tab with an unrelated, ungranted
      // frame. Discover it even when the all-frames injection rejects the batch.
      const available = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
      const permitted = [];
      for (const frame of available || []) {
        const pattern = originPattern(frame.url);
        if (pattern && await chrome.permissions.contains({ origins: [pattern] })) permitted.push(frame.frameId);
      }
      const frameIds = [...new Set([...knownFrameIds, ...permitted])];
      for (const frameId of frameIds.filter(id => id !== 0)) {
        try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["shared.js", "content.js"] }); }
        catch { /* Keep it eligible for a probe; its existing isolated script can still respond. */ }
      }
      return [...new Set([0, ...frameIds])];
    } catch { throw new Error(`无法连接课程页面，请刷新后再试。${error.message || ""}`); }
  }
}
function initialSession(tab, origin) {
  return {
    behaviorVersion: BEHAVIOR_VERSION, tabId: tab.id, origin, url: tab.url, running: true, phase: "detecting", taskType: "unknown",
    title: "正在识别课程", detail: "正在查找视频、文档与课程正文…", elapsedSeconds: 0,
    remainingSeconds: 0, videoCurrent: 0, videoDuration: 0, scroll: null, flow: null, embedded: {},
    completedCount: 0, history: [], completedKeys: [], activeFrameId: null, activeKey: null, activeRunId: null,
    frameIds: [0], checkpoint: null, nextAt: null, awaitingKey: null, navigationStartedAt: null,
    updatedAt: Date.now(), lastProbeAt: 0, detectionStartedAt: Date.now(), diagnostics: null
  };
}
async function stopFrames(session, type = "ENGINE_STOP") {
  session.embedded = {};
  for (const key of embeddedReady.keys()) if (key.startsWith(`${session.tabId}:`)) embeddedReady.delete(key);
  for (const [key, timer] of embeddedTimers) if (key.startsWith(`${session.tabId}:`)) {
    clearTimeout(timer);
    embeddedTimers.delete(key);
  }
  return Promise.all([...new Set(session.frameIds || [0])].map(frame => send(session.tabId, frame, { type })));
}

function clearEmbeddedTimer(session, token) {
  const key = `${session.tabId}:${token}`;
  clearTimeout(embeddedTimers.get(key));
  embeddedTimers.delete(key);
}
async function reconnectEmbeddedReceiver(session, entry) {
  if (session.embedded?.[entry.token] !== entry || entry.started || !session.running ||
      entry.runId !== session.activeRunId || entry.expiresAt <= Date.now()) return;
  const pattern = entry.frameOrigin;
  if (!pattern || !await chrome.permissions.contains({ origins: [pattern] })) return;
  // A lazy Word frame can be created after the initial tab injection, and its
  // first flow-bind can precede its receiver. Connect only this owner's actual
  // permitted children, then ask the same owner to repeat its original token.
  await registerOrigin(pattern);
  const frames = await chrome.webNavigation.getAllFrames({ tabId: session.tabId }).catch(() => []);
  for (const frame of frames || []) {
    if (frame.parentFrameId !== entry.ownerFrameId || originPattern(frame.url) !== pattern) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: session.tabId, frameIds: [frame.frameId] }, files: ["shared.js", "content.js"] });
      if (!session.frameIds.includes(frame.frameId)) session.frameIds.push(frame.frameId);
    } catch { /* A loading frame announces ENGINE_READY when its receiver exists. */ }
  }
  if (session.embedded?.[entry.token] === entry && !entry.started && session.running && entry.runId === session.activeRunId) {
    await send(session.tabId, entry.ownerFrameId, { type: "ENGINE_EMBEDDED_REBIND", token: entry.token, runId: entry.runId });
  }
}
async function expireEmbedded(session, entry) {
  clearEmbeddedTimer(session, entry.token);
  embeddedReady.delete(`${session.tabId}:${entry.token}`);
  if (session.embedded?.[entry.token] !== entry || entry.started || !session.running || entry.runId !== session.activeRunId) return;
  delete session.embedded[entry.token];
  await send(session.tabId, entry.ownerFrameId, { type: "ENGINE_EMBEDDED_RETURN", token: entry.token,
    runId: entry.runId, ok: false, detail: "连接内嵌内容超时，请点击“连接内嵌内容”后继续，当前阅读位置已保留。" });
  await save(session);
}
async function startEmbedded(session, entry) {
  if (session.embedded?.[entry.token] !== entry || entry.started || !session.running || entry.runId !== session.activeRunId) return;
  if (entry.expiresAt <= Date.now()) return expireEmbedded(session, entry);
  const readyKey = `${session.tabId}:${entry.token}`;
  const child = embeddedReady.get(readyKey);
  if (!child || child.expiresAt < Date.now() || child.frameId === entry.ownerFrameId) return;
  const probe = await send(session.tabId, child.frameId, { type: "ENGINE_PROBE", settings, viewportEnabled: true });
  if (!probe?.candidate && probe?.reason === "not_found") {
    // The Word preview may announce its script before rendering its pages.
    // Retain the original owner and pairing while its content becomes available.
    child.expiresAt = entry.expiresAt;
    clearEmbeddedTimer(session, entry.token);
    embeddedTimers.set(readyKey, setTimeout(() => {
      void serialize(session.tabId, () => startEmbedded(session, entry)).catch(() => {});
    }, Math.min(500, Math.max(0, entry.expiresAt - Date.now()))));
    return;
  }
  embeddedReady.delete(readyKey);
  clearEmbeddedTimer(session, entry.token);
  entry.started = true;
  entry.childFrameId = child.frameId;
  if (!session.frameIds.includes(child.frameId)) session.frameIds.push(child.frameId);
  await save(session);
  const result = await send(session.tabId, child.frameId, { type: "ENGINE_EMBEDDED_RUN", token: entry.token,
    runId: entry.runId, resetPosition: entry.resetPosition, settings });
  if (!result?.ok) {
    delete session.embedded[entry.token];
    await send(session.tabId, entry.ownerFrameId, { type: "ENGINE_EMBEDDED_RETURN", token: entry.token,
      runId: entry.runId, ok: false, detail: result?.error || "无法连接当前内嵌内容，请检查权限后重新识别。" });
    await save(session);
  }
}

async function handleEmbedded(session, message, frameId) {
  if (!session.running || !session.activeRunId || typeof message.token !== "string" ||
      message.token.length < 8 || message.token.length > 160) return { ok: true };
  session.embedded ||= {};
  for (const [key, entry] of embeddedReady) if (entry.expiresAt < Date.now()) embeddedReady.delete(key);
  if (message.type === "ENGINE_EMBEDDED_READY") {
    if (embeddedReady.size < 64) embeddedReady.set(`${session.tabId}:${message.token}`, { frameId, expiresAt: Date.now() + 5000 });
    const pending = session.embedded[message.token];
    if (pending) await startEmbedded(session, pending);
    return { ok: true };
  }
  if (message.runId !== session.activeRunId) return { ok: true };
  if (message.type === "ENGINE_EMBEDDED_REQUEST") {
    const owner = frameId === session.activeFrameId && message.key === session.activeKey;
    const nestedOwner = Object.values(session.embedded).some(entry => entry.started && entry.childFrameId === frameId && entry.runId === message.runId);
    if (!owner && !nestedOwner) return { ok: true };
    // One child at a time per owner; obsolete tokens cannot redirect a later return.
    for (const [token, entry] of Object.entries(session.embedded)) if (entry.ownerFrameId === frameId && token !== message.token) {
      clearEmbeddedTimer(session, token);
      delete session.embedded[token];
    }
    const entry = session.embedded[message.token] ||= { token: message.token, ownerFrameId: frameId,
      runId: message.runId, resetPosition: message.resetPosition !== false, started: false, expiresAt: Date.now() + 12000 };
    const frameOrigin = originPattern(message.frameOrigin);
    entry.frameOrigin = frameOrigin;
    if (frameOrigin && !await chrome.permissions.contains({ origins: [frameOrigin] })) {
      session.frameOrigins = [...new Set([...(session.frameOrigins || []), frameOrigin])];
      clearEmbeddedTimer(session, entry.token);
      await send(session.tabId, frameId, { type: "ENGINE_EMBEDDED_RETURN", token: entry.token,
        runId: entry.runId, ok: false,
        detail: `内嵌文档或播放器尚未连接（${new URL(frameOrigin).hostname}），请点击“连接内嵌内容”后继续，当前阅读位置已保留。` });
      await save(session);
      return { ok: true };
    }
    const timerKey = `${session.tabId}:${message.token}`;
    if (!entry.started && !embeddedTimers.has(timerKey)) embeddedTimers.set(timerKey, setTimeout(() => {
      void serialize(session.tabId, () => expireEmbedded(session, entry)).catch(() => {});
    }, Math.max(0, entry.expiresAt - Date.now())));
    if (!entry.started && !embeddedReady.has(timerKey)) await reconnectEmbeddedReceiver(session, entry);
    await startEmbedded(session, entry);
    await save(session);
    return { ok: true };
  }
  const entry = session.embedded[message.token];
  if (!entry?.started || entry.childFrameId !== frameId || entry.runId !== message.runId) return { ok: true };
  if (message.type === "ENGINE_EMBEDDED_PROGRESS") {
    await send(session.tabId, entry.ownerFrameId, { type: "ENGINE_EMBEDDED_STATUS", token: entry.token, runId: entry.runId, snapshot: message.snapshot });
  } else if (message.type === "ENGINE_EMBEDDED_DONE") {
    clearEmbeddedTimer(session, message.token);
    delete session.embedded[message.token];
    await send(session.tabId, entry.ownerFrameId, { type: "ENGINE_EMBEDDED_RETURN", token: entry.token,
      runId: entry.runId, ok: true, snapshot: message.snapshot });
    await save(session);
  }
  return { ok: true };
}
async function block(session, detail, phase = "blocked") {
  session.phase = phase;
  session.detail = detail;
  session.running = false;
  session.nextAt = null;
  clearAdvance(session.tabId);
  clearTimeout(probeTimers.get(session.tabId));
  probeTimers.delete(session.tabId);
  await stopFrames(session);
  await save(session);
}

async function probeAndRun(session, { reinject = false } = {}) {
  if (!session.running || session.nextAt) return;
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  if (!tab) return;
  if (originPattern(tab.url) !== session.origin) {
    await stopFrames(session);
    return block(session, "已离开启动时的课程网站，请在新页面重新开始。");
  }
  session.url = tab.url;
  session.lastProbeAt = Date.now();
  if (reinject) session.frameIds = await inject(session.tabId, session.frameIds);
  const results = await Promise.all([...new Set(session.frameIds || [0])].map(async frameId => ({
    frameId, result: await send(session.tabId, frameId, { type: "ENGINE_PROBE", settings, viewportEnabled: session.running })
  })));
  const topResult = results.find(item => item.frameId === 0)?.result;
  session.frameOrigins = [...new Set(results.flatMap(item => item.result?.frameOrigins || []).map(originPattern).filter(Boolean))];
  session.diagnostics = makeDiagnostics(session, results);
  if (results.every(item => !item.result)) {
    return block(session, "未能连接课程页面脚本。请刷新课程网页后重新识别；若刚更新插件，请先在扩展页重新加载。", "error");
  }
  const nextContext = topResult?.contextKey || "";
  const contextChanged = session.taskContext !== undefined && session.taskContext !== nextContext;
  if (contextChanged) {
    session.checkpoint = null;
    session.phase = "detecting";
  }
  session.taskContext = nextContext;
  const errors = results.filter(item => item.result?.error);
  if (errors.length) return block(session, errors[0].result.error, "error");
  if (results.some(item => item.frameId === 0 && item.result?.reason === "manual_action")) {
    return block(session, "当前是测验、考试或实操任务，请手动完成后再继续。");
  }
  const candidates = results.filter(item => item.result?.candidate).map(item => ({
    frameId: item.frameId, ...item.result.candidate
  })).sort((left, right) => Number(Boolean(right.flowRoot)) - Number(Boolean(left.flowRoot)) ||
    (left.flowRoot && right.flowRoot ?
      (Number.isFinite(left.frameDepth) ? left.frameDepth : Number(left.frameId !== 0)) -
      (Number.isFinite(right.frameDepth) ? right.frameDepth : Number(right.frameId !== 0)) : 0) ||
    Number(Boolean(right.readingBeforeVideo)) - Number(Boolean(left.readingBeforeVideo)) || (right.score || 0) - (left.score || 0));
  const candidate = candidates[0];
  if (!candidate) {
    if (results.some(item => item.result?.reason === "manual_action")) {
      await stopFrames(session);
      return block(session, "当前是测验、考试或实操任务，请手动完成后再继续。");
    }
    const ungranted = await missingFrameOrigins(session);
    if (ungranted.length) {
      return block(session, `检测到未授权的内嵌播放器或课件（${ungranted.map(pattern => new URL(pattern).hostname).join("、")}），请点击“连接内嵌内容”后继续。`);
    }
    const pageDetail = results.map(item => item.result?.detail).filter(Boolean).join("；");
    const explanation = pageDetail || "当前页面没有匹配到视频、文档阅读器或正文区域。";
    session.detectionStartedAt ??= Date.now();
    const deadline = session.navigationStartedAt ? session.navigationStartedAt + 20000 : session.detectionStartedAt + DETECTION_TIMEOUT_MS;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return block(session, `识别已超时。${explanation} 请确认已打开具体课时；可在设置中复制识别诊断，或填写网站适配选择器。`);
    }
    session.phase = "detecting";
    session.detail = `${explanation} 正在重试（最多 ${Math.ceil(remaining / 1000)} 秒）。`;
    await save(session);
    scheduleProbe(session.tabId, Math.min(2000, remaining));
    return;
  }
  const identity = taskIdentity(session, candidate.frameId, candidate.key);
  const selectedDifferentContent = contextChanged || session.activeFrameId !== candidate.frameId || session.activeKey !== candidate.key;
  // A manual revisit is a fresh run. Keep the current ended event deduplicated until selection changes.
  if (selectedDifferentContent && session.awaitingKey !== identity) {
    session.completedKeys = session.completedKeys.filter(key => key !== identity);
    if (session.awaitingKey === identity) session.awaitingKey = null;
  }
  if (session.awaitingKey === identity || session.completedKeys.includes(identity)) {
    if (!session.navigationStartedAt) {
      return block(session, "当前任务已处理，请手动选择下一项后点击继续。");
    }
    if (session.navigationStartedAt && Date.now() - session.navigationStartedAt > 15000) {
      return block(session, "未切换到新的任务。请手动选择下一项，再点击继续。");
    }
    session.phase = "navigating";
    session.detail = "等待下一项课程内容加载…";
    await save(session);
    scheduleProbe(session.tabId, 1000);
    return;
  }
  const waitingOnEmbedded = session.phase === "waiting" && Object.values(session.embedded || {}).some(entry =>
    entry.ownerFrameId === candidate.frameId && entry.runId === session.activeRunId &&
    (entry.started || entry.expiresAt > Date.now()));
  if (!contextChanged && session.activeFrameId === candidate.frameId && session.activeKey === candidate.key &&
      (["reading", "centering", "playing", "waiting_completion", "blocked"].includes(session.phase) || waitingOnEmbedded)) return;
  const checkpoint = session.checkpoint?.key === candidate.key ? session.checkpoint : null;
  if (session.activeFrameId !== null && selectedDifferentContent) {
    await stopFrames(session);
    // All ancestors remain available to confirm child geometry, but old children have stopped.
    await Promise.all((session.frameIds || [0]).filter(frameId => frameId !== candidate.frameId)
      .map(frameId => send(session.tabId, frameId, { type: "ENGINE_PROBE", settings, viewportEnabled: true })));
  }
  session.activeFrameId = candidate.frameId;
  session.activeKey = candidate.key;
  session.activeRunId = crypto.randomUUID();
  session.awaitingKey = null;
  session.navigationStartedAt = null;
  session.detectionStartedAt = null;
  clearTimeout(probeTimers.get(session.tabId));
  probeTimers.delete(session.tabId);
  session.taskType = candidate.type;
  session.title = candidate.title;
  session.elapsedSeconds = checkpoint?.elapsedSeconds || 0;
  session.remainingSeconds = 0;
  session.scroll = checkpoint?.scroll || null;
  session.flow = checkpoint?.flow || null;
  session.embedded = {};
  session.videoCurrent = 0;
  session.videoDuration = 0;
  session.phase = "detecting";
  session.detail = candidate.detail || "正在开始当前任务…";
  await save(session);
  const result = await send(session.tabId, candidate.frameId, { type: "ENGINE_RUN", settings, checkpoint,
    runId: session.activeRunId, resetPosition: !checkpoint });
  if (!result?.ok) await block(session, result?.error || "课程页面连接中断，请刷新页面后重试。", "error");
}
function scheduleProbe(tabId, delay = 500, reinject = false) {
  clearTimeout(probeTimers.get(tabId));
  probeTimers.set(tabId, setTimeout(() => {
    probeTimers.delete(tabId);
    return serialize(tabId, async () => {
      const session = sessions.get(tabId);
      if (session?.running) await probeAndRun(session, { reinject });
    }).catch(error => reportError(tabId, error));
  }, delay));
}
async function missingFrameOrigins(session) {
  const missing = [];
  for (const pattern of session.frameOrigins || []) {
    if (!await chrome.permissions.contains({ origins: [pattern] })) missing.push(pattern);
  }
  return missing;
}
function makeDiagnostics(session, results, frameMetadata = new Map()) {
  return {
    version: chrome.runtime.getManifest?.().version || "1.2.1",
    capturedAt: new Date().toISOString(), site: session.origin, phase: session.phase,
    frames: results.map(({ frameId, result }) => ({
      frameId, ...(frameMetadata.get(frameId) || {}), responded: Boolean(result), reason: result?.reason || (result?.candidate ? "matched" : "no_receiver"),
      detail: result?.detail || result?.error || "", candidate: result?.candidate ? {
        type: result.candidate.type, title: result.candidate.title, ready: result.candidate.ready
      } : null, diagnostics: result?.diagnostics || null
    }))
  };
}
function scheduleAdvance(session) {
  clearAdvance(session.tabId);
  if (!session.running || !session.nextAt) return;
  delayedAdvances.set(session.tabId, setTimeout(() => {
    delayedAdvances.delete(session.tabId);
    void serialize(session.tabId, async () => {
      const current = sessions.get(session.tabId);
      if (current?.running && current.nextAt && current.nextAt <= Date.now()) await advance(current);
    }).catch(error => reportError(session.tabId, error));
  }, Math.max(0, session.nextAt - Date.now())));
}
async function advance(session) {
  if (!settings.autoNext) return block(session, "当前任务已结束，自动进入下一项已关闭。", "completed");
  session.nextAt = null;
  session.phase = "navigating";
  session.navigationStartedAt = Date.now();
  session.detail = "正在进入下一项…";
  await save(session);
  let result = await send(session.tabId, 0, { type: "ENGINE_ADVANCE", settings });
  if (!result?.ok && result?.reason !== "manual_action" && session.activeFrameId && result?.reason !== "end") {
    const nested = await send(session.tabId, session.activeFrameId, { type: "ENGINE_ADVANCE", settings });
    if (nested?.ok || nested?.reason === "manual_action" || !result) result = nested;
  }
  if (result?.ok) {
    session.activeFrameId = null;
    session.activeKey = null;
    session.checkpoint = null;
    await save(session);
    scheduleProbe(session.tabId, 1000, true);
  } else if (result?.reason === "end") {
    await block(session, "已到课程末尾，本次连续学习结束。", "completed");
  } else if (result?.reason === "manual_action") {
    await block(session, result.detail || "下一项需要手动完成，请完成后再继续。");
  } else {
    await block(session, result?.detail || "未找到可用的下一项。请手动打开下一任务，或设置“下一项”选择器。");
  }
}
async function finishTask(session, message, frameId) {
  if (!session.running || session.activeFrameId !== frameId || session.activeKey !== message.key || message.runId !== session.activeRunId) return;
  // A media ended event is only a page segment; only the full page may finish the task.
  if (message.completionReason !== "platform") return;
  const identity = taskIdentity(session, frameId, message.key);
  if (session.completedKeys.includes(identity)) return;
  session.completedKeys.push(identity);
  session.completedKeys = session.completedKeys.slice(-500);
  session.completedCount += 1;
  session.history.unshift({ title: session.title, type: session.taskType, at: Date.now() });
  session.history = session.history.slice(0, 20);
  session.remainingSeconds = 0;
  session.awaitingKey = identity;
  session.checkpoint = null;
  if (!settings.autoNext) return block(session, "当前任务已结束，自动进入下一项已关闭。", "completed");
  session.phase = "waiting";
  session.detail = `${settings.nextDelaySeconds} 秒后进入下一项…`;
  session.nextAt = Date.now() + settings.nextDelaySeconds * 1000;
  await save(session);
  scheduleAdvance(session);
}

async function handleControl(message) {
  const tab = await chrome.tabs.get(message.tabId);
  const pattern = originPattern(tab.url);
  if (!pattern) throw new Error("请在华为 ICT 学院的课程网页中打开插件。");
  let session = sessions.get(message.tabId);
  if (["start", "restart"].includes(message.action)) {
    if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error("请先允许插件访问当前课程网站。");
    if (session) {
      session.running = false;
      session.nextAt = null;
      session.pauseNextRemaining = null;
      session.checkpoint = null;
      session.activeRunId = null;
      session.phase = "idle";
      session.detail = "已停止旧任务，正在从当前页面重新开始…";
      clearAdvance(session.tabId);
      clearTimeout(probeTimers.get(session.tabId));
      probeTimers.delete(session.tabId);
      await stopFrames(session);
      await save(session);
    }
    session = initialSession(tab, pattern);
    await save(session);
    try {
      await registerOrigin(pattern);
      session.frameIds = await inject(tab.id);
      await save(session);
      await probeAndRun(session);
    } catch (error) {
      await block(session, error.message || "重新开始失败，请刷新当前课程页面后再试。", "error");
      throw error;
    }
  } else if (!session) {
    throw new Error("请先开始当前页面的课程任务。");
  } else if (message.action === "pause") {
    session.running = false;
    session.pauseFrom = session.phase;
    session.pauseNextRemaining = session.nextAt ? Math.max(0, session.nextAt - Date.now()) : null;
    session.nextAt = null;
    clearAdvance(session.tabId);
    const snapshots = await stopFrames(session, "ENGINE_PAUSE");
    const snapshot = snapshots.find(item => item?.snapshot?.key === session.activeKey)?.snapshot;
    if (snapshot) {
      session.elapsedSeconds = snapshot.elapsedSeconds ?? session.elapsedSeconds;
      session.remainingSeconds = session.taskType === "video" ? snapshot.remainingSeconds ?? session.remainingSeconds : 0;
      session.videoCurrent = snapshot.videoCurrent ?? session.videoCurrent;
      session.scroll = snapshot.scroll ?? session.scroll;
      session.flow = snapshot.flow ?? session.flow;
      session.taskType = snapshot.taskType ?? session.taskType;
    }
    session.checkpoint = { key: session.activeKey, elapsedSeconds: session.elapsedSeconds, scroll: session.scroll, flow: session.flow };
    session.phase = "paused";
    session.detail = "已暂停，可随时继续。";
    await save(session);
  } else if (message.action === "stop") {
    session.running = false;
    session.nextAt = null;
    clearAdvance(session.tabId);
    await stopFrames(session);
    session.phase = "idle";
    session.detail = "已停止；再次开始会创建新的学习会话。";
    session.checkpoint = null;
    await save(session);
  } else if (["resume", "rescan"].includes(message.action)) {
    if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error("当前网站访问权限已被撤回，请重新开始并授权。");
    if (pattern !== session.origin) throw new Error("当前网页已更换网站，请点击停止后重新开始。");
    const phase = session.phase;
    session.running = true;
    if (phase === "paused" && session.pauseFrom === "waiting" && session.pauseNextRemaining !== null) {
      session.nextAt = Date.now() + session.pauseNextRemaining;
      session.phase = "waiting";
      session.detail = "即将进入下一项…";
      await save(session);
      scheduleAdvance(session);
    } else if (session.nextAt) {
      scheduleAdvance(session);
    } else {
      const results = await stopFrames(session, "ENGINE_PAUSE");
      const snapshot = results.find(result => result?.snapshot?.key === session.activeKey &&
        result.snapshot.runId === session.activeRunId)?.snapshot;
      if (snapshot) {
        session.elapsedSeconds = snapshot.elapsedSeconds ?? session.elapsedSeconds;
        session.scroll = snapshot.scroll ?? session.scroll;
        session.flow = snapshot.flow ?? session.flow;
        session.checkpoint = { key: session.activeKey, elapsedSeconds: session.elapsedSeconds,
          scroll: session.scroll, flow: session.flow };
      }
      session.phase = "detecting";
      session.navigationStartedAt = null;
      session.detectionStartedAt = Date.now();
      for (const pattern of session.frameOrigins || []) {
        if (await chrome.permissions.contains({ origins: [pattern] })) await registerOrigin(pattern);
      }
      session.frameIds = await inject(session.tabId, session.frameIds);
      await save(session);
      await probeAndRun(session);
    }
  } else throw new Error("未知操作。");
  return { ok: true, status: publicStatus(session) };
}
async function reportError(tabId, error) {
  const session = sessions.get(tabId);
  if (session) await block(session, error.message || "发生错误，请刷新页面重试。", "error");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string") return false;
  const fromContent = Boolean(sender.tab);
  if (fromContent && !message.type.startsWith("ENGINE_")) return false;
  if (!fromContent && message.type.startsWith("ENGINE_")) return false;
  const tabId = fromContent ? sender.tab.id : message.tabId;
  const handler = async () => {
    if (message.type === "SETTINGS_SAVE") {
      settings = normalizeSettings(message.settings);
      await chrome.storage.local.set({ settings });
      for (const session of sessions.values()) {
        if (!settings.autoNext && session.nextAt) {
          await block(session, "当前任务已结束，自动进入下一项已关闭。", "completed");
        }
        for (const frameId of session.frameIds || [0]) void send(session.tabId, frameId, { type: "ENGINE_SETTINGS", settings });
      }
      return { ok: true, settings };
    }
    if (message.type === "POPUP_STATUS") {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const pattern = originPattern(tab?.url);
      const permission = Boolean(pattern && await chrome.permissions.contains({ origins: [pattern] }));
      const session = sessions.get(tabId);
      if (session?.running && session.nextAt) scheduleAdvance(session);
      const additionalOrigins = session ? await missingFrameOrigins(session) : [];
      return { ok: true, status: publicStatus(session), settings, permission,
        connection: { available: Boolean(pattern), message: pattern ? "已就绪" : "请打开课程网页后使用", additionalOrigins } };
    }
    if (message.type === "GET_DIAGNOSTICS") {
      const tab = await chrome.tabs.get(tabId);
      const pattern = originPattern(tab.url);
      if (!pattern || !await chrome.permissions.contains({ origins: [pattern] })) throw new Error("请先点击开始并允许访问当前课程网站，再复制识别诊断。");
      const session = sessions.get(tabId) || initialSession(tab, pattern);
      const knownFrameIds = new Set(session.frameIds || [0]);
      const actualFrames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
      const connectedFrames = session.running && session.activeFrameId !== null ? [...knownFrameIds] : await inject(tabId, session.frameIds);
      const frameIds = [...new Set([...connectedFrames, ...(actualFrames || []).map(frame => frame.frameId)])];
      const metadata = new Map();
      for (const frame of actualFrames || []) {
        const origin = originPattern(frame.url);
        const pending = Object.values(session.embedded || {}).find(entry => entry.childFrameId === frame.frameId ||
          !entry.started && entry.ownerFrameId === frame.parentFrameId && entry.frameOrigin === origin);
        metadata.set(frame.frameId, { parentFrameId: frame.parentFrameId, origin: origin ? new URL(origin).origin : null,
          permission: origin ? await chrome.permissions.contains({ origins: [origin] }) : null,
          known: knownFrameIds.has(frame.frameId), connectionPending: Boolean(pending && !pending.started),
          ...(pending ? { connectionOwnerFrameId: pending.ownerFrameId, connectionStarted: pending.started } : {}) });
      }
      const results = await Promise.all(frameIds.map(async frameId => ({ frameId, result: await send(tabId, frameId, { type: "ENGINE_PROBE", settings, viewportEnabled: Boolean(session.running) }) })));
      return { ok: true, diagnostics: makeDiagnostics(session, results, metadata) };
    }
    if (message.type === "CONTROL") return handleControl(message);
    const session = sessions.get(tabId);
    if (!session) return { ok: true };
    const frameId = sender.frameId ?? 0;
    if (message.type.startsWith("ENGINE_EMBEDDED_")) return handleEmbedded(session, message, frameId);
    if (message.type === "ENGINE_READY") {
      if (!session.frameIds.includes(frameId)) session.frameIds.push(frameId);
      if (session.running) for (const entry of Object.values(session.embedded || {})) {
        if (entry.started || entry.runId !== session.activeRunId || entry.expiresAt <= Date.now() ||
            !entry.frameOrigin || !await chrome.permissions.contains({ origins: [entry.frameOrigin] })) continue;
        await send(tabId, entry.ownerFrameId, { type: "ENGINE_EMBEDDED_REBIND", token: entry.token, runId: entry.runId });
      }
      if (session.running) scheduleProbe(tabId, 650);
      return { ok: true };
    }
    if (message.type === "ENGINE_CHANGED") {
      // A user can select another task during the inter-task delay. Cancel the old next click.
      const selectedAnotherTask = (session.activeFrameId === frameId && message.candidate?.key &&
        message.candidate.key !== session.activeKey) || (frameId === 0 && message.contextKey && message.contextKey !== session.taskContext);
      if (session.running && session.nextAt && selectedAnotherTask) {
        clearAdvance(tabId);
        session.nextAt = null;
        session.phase = "detecting";
      }
      if (session.running && message.elementReplaced && session.activeFrameId === frameId && !session.nextAt) {
        session.phase = "detecting";
      }
      if (session.running && !session.nextAt) scheduleProbe(tabId, 450, true);
      return { ok: true };
    }
    if (message.type === "ENGINE_PROGRESS") {
      const snapshot = message.snapshot;
      if (!session.running || session.activeFrameId !== frameId || !snapshot || snapshot.key !== session.activeKey || snapshot.runId !== session.activeRunId ||
          session.awaitingKey === taskIdentity(session, frameId, snapshot.key)) return { ok: true };
      if (["reading", "centering", "playing", "paused", "blocked", "waiting", "waiting_completion", "error"].includes(snapshot.phase)) session.phase = snapshot.phase;
      for (const key of ["taskType", "detail", "remainingSeconds", "elapsedSeconds", "videoCurrent", "videoDuration", "scroll", "flow"]) {
        if (snapshot[key] !== undefined) session[key] = snapshot[key];
      }
      if (session.taskType !== "video") session.remainingSeconds = 0;
      session.checkpoint = { key: session.activeKey, elapsedSeconds: session.elapsedSeconds, scroll: session.scroll, flow: session.flow };
      await save(session);
      return { ok: true };
    }
    if (message.type === "ENGINE_DONE") { await finishTask(session, message, frameId); return { ok: true }; }
    return { ok: false, error: "未知消息。" };
  };
  const operation = Number.isInteger(tabId) ? serialize(tabId, handler) : ready.then(handler);
  void operation.then(respond).catch(error => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  void serialize(tabId, async () => {
    clearAdvance(tabId);
    clearTimeout(probeTimers.get(tabId));
    probeTimers.delete(tabId);
    const session = sessions.get(tabId);
    if (session) { session.running = false; await stopFrames(session); }
    sessions.delete(tabId);
    await chrome.storage.session.remove(`${SESSION_PREFIX}${tabId}`);
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void ready.then(() => {
    const session = sessions.get(tabId);
    if (!session?.running) return;
    if (changeInfo.status === "loading" || changeInfo.url) {
      void serialize(tabId, async () => {
        if (!session.running) return;
        if (session.nextAt) {
          clearAdvance(tabId);
          session.nextAt = null;
          session.phase = "detecting";
        }
        if (changeInfo.status === "loading") { session.phase = "detecting"; session.activeFrameId = null; session.detectionStartedAt = Date.now(); }
        if (changeInfo.url && originPattern(changeInfo.url) !== session.origin) {
          await stopFrames(session);
          await block(session, "已离开当前课程网站，请在新页面重新开始。");
        } else await save(session);
      });
    }
    if (changeInfo.status === "complete" || changeInfo.url) scheduleProbe(tabId, 700, true);
  });
});
chrome.permissions.onRemoved.addListener(() => {
  void ready.then(async () => {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    for (const script of registered) {
      if (!script.id.startsWith("itc-")) continue;
      if (!await chrome.permissions.contains({ origins: script.matches })) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
    }
    for (const session of sessions.values()) {
      if (!session.running || await chrome.permissions.contains({ origins: [session.origin] })) continue;
      void serialize(session.tabId, async () => {
        await stopFrames(session);
        await block(session, "课程网站访问权限已撤回，已停止自动处理。");
      });
    }
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== "itc-watchdog") return;
  void ready.then(() => {
    for (const session of sessions.values()) {
      if (!session.running) continue;
      void serialize(session.tabId, async () => {
        if (session.nextAt) {
          if (session.nextAt <= Date.now()) await advance(session);
          else scheduleAdvance(session);
        } else if (["detecting", "navigating"].includes(session.phase)) {
          await probeAndRun(session, { reinject: true });
        } else {
          const alive = await send(session.tabId, session.activeFrameId ?? 0, { type: "ENGINE_PROBE", settings, viewportEnabled: session.running });
          if (!alive) await probeAndRun(session, { reinject: true });
        }
      }).catch(error => reportError(session.tabId, error));
    }
  });
});
