"use strict";

// Browser integration harness for the actual content.js. This mini coordinator
// only exists on the local fixture; background.js has separate regression tests.
(() => {
  const listeners = [];
  let active = false;
  let pendingTimer = null;
  let changedTimer = null;
  let checkpoint = null;
  let lastSnapshot = null;
  let nextAt = null;
  let pausedDelay = null;
  let completed = new Set();
  let history = [];
  let activeContextKey = null;
  let freshPosition = true;
  const settings = { theme: "light", scrollIntervalSeconds: 1, scrollEnabled: true, autoNext: true, muteVideo: true, nextDelaySeconds: 1, selectors: { video: "", document: "", next: "", task: "", activeTask: "", completed: "#platformComplete" } };
  const panel = document.createElement("section");
  panel.id = "engineHarness";
  panel.style.cssText = "display:grid;gap:12px;margin-top:18px;padding:16px;background:#eef4ff;border:1px solid #a4bcf1;border-radius:12px;font:14px/1.6 Segoe UI,sans-serif;";
  panel.innerHTML = '<strong>真实内容引擎验证</strong><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center"><label>滚动间隔（秒，±10%） <input id="engineScrollInterval" type="number" min="1" max="3600" value="1" style="width:70px"></label><label><input id="engineAutoNext" type="checkbox" checked> 自动下一项</label><label><input id="engineScroll" type="checkbox" checked> 向下滚动</label><button id="engineStart" type="button">开始</button><button id="engineRestart" type="button">重新开始</button><button id="enginePause" type="button">暂停</button><button id="engineResume" type="button">继续</button><button id="engineStop" type="button">停止</button><button id="engineDetect" type="button">识别</button></div><output id="engineState">引擎加载中</output><output id="engineHistory">已完成：0</output><pre id="engineSnapshot" style="margin:0;white-space:pre-wrap;font:12px/1.4 monospace;max-height:180px;overflow:auto"></pre><details><summary>最近消息</summary><pre id="engineMessages" style="margin:0;white-space:pre-wrap;font:12px/1.4 monospace;max-height:180px;overflow:auto"></pre></details>';
  document.querySelector("header").append(panel);
  const state = (value) => { document.querySelector("#engineState").textContent = value; };
  const log = (message) => {
    const output = document.querySelector("#engineMessages");
    const line = typeof message === "string" ? message : JSON.stringify(message);
    output.textContent = (output.textContent + line + "\n").split("\n").slice(-30).join("\n");
  };
  const ask = (message) => new Promise((resolve) => {
    for (const listener of listeners) listener(message, {}, resolve);
    if (!listeners.length) resolve({ ok: false, error: "Engine not ready" });
  });
  function cancelPending() { clearTimeout(pendingTimer); pendingTimer = null; nextAt = null; }
  function readSettings() {
    settings.scrollIntervalSeconds = Math.min(3600, Math.max(1, Number(document.querySelector("#engineScrollInterval").value) || 1));
    settings.autoNext = document.querySelector("#engineAutoNext").checked;
    settings.scrollEnabled = document.querySelector("#engineScroll").checked;
  }
  async function probeAndRun() {
    if (!active || pendingTimer) return;
    const result = await ask({ type: "ENGINE_PROBE", settings });
    log({ probe: result });
    if (!active) return;
    if (!result?.candidate) { state(result?.detail || result?.error || result?.reason || "未识别"); return; }
    if (activeContextKey !== result.contextKey) { activeContextKey = result.contextKey; lastSnapshot = null; checkpoint = null; freshPosition = true; }
    if (completed.has(`${activeContextKey}:${result.candidate.key}`)) { state("等待切换到新任务"); return; }
    if (lastSnapshot?.key === result.candidate.key && ["reading", "centering", "playing", "waiting_completion"].includes(lastSnapshot.phase)) return;
    const started = await ask({ type: "ENGINE_RUN", settings, checkpoint, resetPosition: freshPosition });
    if (started.ok) freshPosition = false;
    log({ run: started });
  }
  async function doAdvance() {
    pendingTimer = null; nextAt = null;
    if (!active) return;
    state("进入下一项");
    const result = await ask({ type: "ENGINE_ADVANCE", settings });
    log({ advance: result });
    if (!result?.ok) { active = false; state(result?.detail || result?.reason || "切换失败"); return; }
    lastSnapshot = null; checkpoint = null; freshPosition = true;
    changedTimer = setTimeout(probeAndRun, 800);
  }
  function scheduleAdvance(delay = settings.nextDelaySeconds * 1000) {
    cancelPending();
    nextAt = Date.now() + delay;
    pendingTimer = setTimeout(doAdvance, delay);
  }
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) {
        if (message.type === "ENGINE_READY") state("引擎已就绪，点击开始");
        if (message.type === "ENGINE_PROGRESS") {
          lastSnapshot = message.snapshot;
          checkpoint = { key: lastSnapshot.key, elapsedSeconds: lastSnapshot.elapsedSeconds, scroll: lastSnapshot.scroll, flow: lastSnapshot.flow };
          state(`${lastSnapshot.phase} · ${lastSnapshot.title} · ${lastSnapshot.detail}`);
          document.querySelector("#engineSnapshot").textContent = JSON.stringify(lastSnapshot, null, 2);
        } else log(message);
        if (message.type === "ENGINE_CHANGED" && active) {
          if (activeContextKey !== message.contextKey) { cancelPending(); lastSnapshot = null; checkpoint = null; freshPosition = true; }
          if (pendingTimer) return { ok: true };
          if (message.elementReplaced) lastSnapshot = null;
          clearTimeout(changedTimer);
          changedTimer = setTimeout(probeAndRun, 450);
        }
        if (message.type === "ENGINE_DONE" && active && !completed.has(`${activeContextKey}:${message.key}`)) {
          completed.add(`${activeContextKey}:${message.key}`);
          history.push(`${message.taskType}: ${message.title}`);
          document.querySelector("#engineHistory").textContent = `已完成：${completed.size} · ${history.join(" → ")}`;
          checkpoint = null;
          if (settings.autoNext) { state("等待进入下一项"); scheduleAdvance(); }
          else { active = false; state("当前任务完成，自动下一项已关闭"); }
        }
        return { ok: true };
      }
    }
  };
  async function restart() {
    cancelPending(); clearTimeout(changedTimer);
    await ask({ type: "ENGINE_STOP" });
    readSettings(); active = true; checkpoint = null; lastSnapshot = null; completed = new Set(); history = []; activeContextKey = null; pausedDelay = null; freshPosition = true;
    document.querySelector("#engineHistory").textContent = "已完成：0";
    await probeAndRun();
  }
  document.querySelector("#engineStart").addEventListener("click", restart);
  document.querySelector("#engineRestart").addEventListener("click", restart);
  document.querySelector("#enginePause").addEventListener("click", async () => {
    active = false;
    pausedDelay = nextAt === null ? null : Math.max(0, nextAt - Date.now());
    cancelPending(); clearTimeout(changedTimer);
    const result = await ask({ type: "ENGINE_PAUSE" });
    if (result.snapshot) checkpoint = { key: result.snapshot.key, elapsedSeconds: result.snapshot.elapsedSeconds, scroll: result.snapshot.scroll, flow: result.snapshot.flow };
    state("已暂停"); log({ pause: result });
  });
  document.querySelector("#engineResume").addEventListener("click", async () => {
    readSettings(); active = true; freshPosition = false;
    if (pausedDelay !== null) { scheduleAdvance(pausedDelay); pausedDelay = null; }
    else { lastSnapshot = null; await probeAndRun(); }
  });
  document.querySelector("#engineStop").addEventListener("click", async () => {
    active = false; cancelPending(); clearTimeout(changedTimer); pausedDelay = null;
    await ask({ type: "ENGINE_STOP" }); state("已停止");
  });
  document.querySelector("#engineDetect").addEventListener("click", async () => {
    readSettings();
    const result = await ask({ type: "ENGINE_PROBE", settings });
    document.querySelector("#engineSnapshot").textContent = JSON.stringify(result, null, 2);
    state(`识别结果：${result.candidate?.type || result.reason || "未知"}`); log({ probe: result });
  });
  ["engineAutoNext", "engineScroll", "engineScrollInterval"].forEach((id) => document.querySelector(`#${id}`).addEventListener("change", async () => {
    readSettings();
    if (!settings.autoNext) cancelPending();
    await ask({ type: "ENGINE_SETTINGS", settings });
  }));
})();
