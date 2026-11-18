"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorker } = require("./helpers/worker-harness.cjs");

const reading = { type: "text", title: "网络基础", key: "read-one", score: 55, detail: "正文", ready: true };
const video = { type: "video", title: "网络视频", key: "video-two", score: 120, detail: "视频", ready: true };
const sender = (frameId = 0) => ({ tab: { id: 7 }, frameId });

function engine(candidate = video, extra = {}) {
  return (message) => {
    if (message.type === "ENGINE_PROBE") return { candidate };
    if (message.type === "ENGINE_RUN") return { ok: true, candidate };
    if (message.type === "ENGINE_PAUSE") return { ok: true, snapshot: { key: candidate?.key, elapsedSeconds: 12.5, remainingSeconds: 0, videoCurrent: 0, scroll: { state: "paused", movements: 2, nextInSeconds: 0, intervalSeconds: 10, enabled: true } } };
    if (message.type === "ENGINE_ADVANCE") return { ok: true, clicked: true };
    return { ok: true, ...extra };
  };
}

function controls(worker, action) { return worker.request({ type: "CONTROL", tabId: 7, action }); }
function status(worker) { return worker.request({ type: "POPUP_STATUS", tabId: 7 }); }
function currentRun(worker, frameId = 0) {
  return worker.messages.filter(item => item.message.type === "ENGINE_RUN" && item.options.frameId === frameId).at(-1)?.message.runId;
}
async function progress(worker, candidate = video, frameId = 0, phase = candidate.type === "video" ? "playing" : "reading") {
  return worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: candidate.key, runId: currentRun(worker, frameId), phase, elapsedSeconds: 12, remainingSeconds: 0, videoCurrent: 0, videoDuration: 0, detail: "实际页面进度" } }, sender(frameId));
}
async function done(worker, candidate = video, frameId = 0) {
  return worker.request({ type: "ENGINE_DONE", key: candidate.key, runId: currentRun(worker, frameId), title: candidate.title,
    taskType: candidate.type, completionReason: "platform" }, sender(frameId));
}
const countMessages = (worker, type) => worker.messages.filter((item) => item.message.type === type).length;

test("start requires an explicit origin permission and never runs on browser-internal pages", async () => {
  const denied = createWorker({ granted: false, frameHandlers: { 0: engine() } });
  const refusal = await controls(denied, "start");
  assert.equal(refusal.ok, false);
  assert.match(refusal.error, /允许|权限|授权/);
  assert.equal(countMessages(denied, "ENGINE_RUN"), 0);
  assert.equal(denied.registrations.length, 0);

  const internal = createWorker({ tab: { url: "edge://extensions/" }, frameHandlers: { 0: engine() } });
  assert.equal((await controls(internal, "start")).ok, false);
  assert.equal(countMessages(internal, "ENGINE_RUN"), 0);
});

test("frame arbitration runs the actual video frame once and ignores stale frames", async () => {
  const worker = createWorker({ frames: [0, 3], frameHandlers: { 0: engine(reading), 3: engine(video) } });
  assert.equal((await controls(worker, "start")).ok, true);
  const runs = worker.messages.filter((item) => item.message.type === "ENGINE_RUN");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].options.frameId, 3);
  assert.equal(worker.registrations[0].matches[0], "https://e.huawei.com/*");
  await progress(worker, reading, 0);
  assert.equal((await status(worker)).status.taskType, "video");
  await done(worker, reading, 0);
  assert.equal((await status(worker)).status.completedCount, 0);
  await progress(worker, video, 3);
  assert.equal((await status(worker)).status.phase, "playing");
});

test("a real task completion is counted once, late progress cannot revive it, and next is clicked once", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  await done(worker);
  await progress(worker);
  let current = (await status(worker)).status;
  assert.equal(current.completedCount, 1);
  assert.equal(current.history.length, 1);
  assert.equal(current.phase, "waiting");
  assert.equal(current.remainingSeconds, 3, "the popup receives the inter-task countdown once the item is complete");
  assert.equal((await worker.chrome.storage.session.get("itc:tab:7"))["itc:tab:7"].remainingSeconds, 0, "the completed task remains complete in its checkpoint");
  await worker.clock.advance(1000);
  assert.equal((await status(worker)).status.remainingSeconds, 2);
  await worker.clock.advance(2000);
  await worker.clock.settle(60);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 1);
  await worker.clock.advance(1000);
  await worker.clock.settle(60);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 1, "the unchanged completed task must never restart");
  current = (await status(worker)).status;
  assert.equal(current.phase, "navigating");
});

test("pause cancels a pending next click and resume keeps the remaining delay", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  await worker.clock.advance(1000);
  assert.equal((await controls(worker, "pause")).status.phase, "paused");
  await worker.clock.advance(10_000);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
  assert.equal((await controls(worker, "resume")).status.phase, "waiting");
  await worker.clock.advance(1999);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
  await worker.clock.advance(1);
  await worker.clock.settle(60);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 1);
});

test("reading pause/resume preserves observations without a reading-completion timer", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine(reading) } });
  await controls(worker, "start");
  await progress(worker, reading);
  assert.equal((await controls(worker, "pause")).status.elapsedSeconds, 12.5);
  await worker.clock.advance(60_000);
  await controls(worker, "resume");
  const lastRun = worker.messages.filter((item) => item.message.type === "ENGINE_RUN").at(-1);
  assert.equal(lastRun.message.checkpoint.key, reading.key);
  assert.equal(lastRun.message.checkpoint.elapsedSeconds, 12.5);
  assert.equal(lastRun.message.checkpoint.scroll.movements, 2);
  assert.equal("remainingSeconds" in lastRun.message.checkpoint, false);
  assert.equal((await status(worker)).status.remainingSeconds, 0);
});

test("stop cancels delayed navigation and refuses late ended events", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  const result = await controls(worker, "stop");
  assert.equal(result.status.running, false);
  assert.equal(result.status.phase, "idle");
  await worker.clock.advance(10_000);
  await done(worker);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
  assert.equal((await status(worker)).status.completedCount, 1);
});

test("turning off auto-next completes the item without touching course navigation", async () => {
  const worker = createWorker({ local: { settings: { autoNext: false } }, frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  await worker.clock.advance(10_000);
  const current = (await status(worker)).status;
  assert.equal(current.phase, "completed");
  assert.equal(current.running, false);
  assert.equal(current.completedCount, 1);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
});

test("a missing next control blocks once without guessing another task or looping", async () => {
  const base = engine();
  const worker = createWorker({ frameHandlers: { 0: (message) => message.type === "ENGINE_ADVANCE" ? { ok: false, reason: "not_found", detail: "未找到下一项" } : base(message) } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  await worker.clock.advance(3000);
  await worker.clock.settle(60);
  const current = (await status(worker)).status;
  assert.equal(current.phase, "blocked");
  assert.equal(current.running, false);
  await worker.clock.advance(60_000);
  await worker.chrome.alarms.onAlarm.dispatch({ name: "itc-watchdog" });
  await worker.clock.settle(60);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 1);
});

test("a disabled final next control produces a completed session", async () => {
  const base = engine();
  const worker = createWorker({ frameHandlers: { 0: (message) => message.type === "ENGINE_ADVANCE" ? { ok: false, reason: "end" } : base(message) } });
  await controls(worker, "start");
  await done(worker);
  await worker.clock.advance(3000);
  await worker.clock.settle(60);
  assert.equal((await status(worker)).status.phase, "completed");
  assert.equal((await status(worker)).status.running, false);
});

test("the worker restores a pending session and its watchdog performs an overdue next exactly once", async () => {
  const first = createWorker({ frameHandlers: { 0: engine() } });
  await controls(first, "start");
  await progress(first);
  await done(first);
  const restarted = createWorker({ session: first.chrome.storage.session.data, frameHandlers: { 0: engine() } });
  await restarted.clock.advance(5000);
  await restarted.chrome.alarms.onAlarm.dispatch({ name: "itc-watchdog" });
  await restarted.clock.settle(60);
  assert.equal(countMessages(restarted, "ENGINE_ADVANCE"), 1);
  assert.equal((await status(restarted)).status.completedCount, 1);
  assert.equal(countMessages(restarted, "ENGINE_RUN"), 0);
  await restarted.chrome.alarms.onAlarm.dispatch({ name: "itc-watchdog" });
  await restarted.clock.settle(60);
  assert.equal(countMessages(restarted, "ENGINE_ADVANCE"), 1);
});

test("leaving the granted website stops automation and tab closure removes its private session", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await progress(worker);
  await worker.chrome.tabs.onUpdated.dispatch(7, { url: "https://other.example/" });
  await worker.clock.settle(60);
  const current = (await status(worker)).status;
  assert.equal(current.running, false);
  assert.equal(current.phase, "blocked");
  assert.ok(countMessages(worker, "ENGINE_STOP") >= 1);
  await worker.chrome.tabs.onRemoved.dispatch(7);
  await worker.clock.settle(60);
  assert.equal((await status(worker)).status, null);
  assert.ok(!Object.hasOwn(worker.chrome.storage.session.data, "itc:tab:7"));
});

test("disabling auto-next while its delay is pending cancels the scheduled navigation", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  await worker.clock.advance(1000);
  await worker.request({ type: "SETTINGS_SAVE", settings: { autoNext: false } });
  await worker.clock.advance(10_000);
  const current = (await status(worker)).status;
  assert.equal(current.running, false);
  assert.equal(current.completedCount, 1);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
});

test("a top-level manual task takes priority over an embedded video candidate", async () => {
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE" ? { candidate: null, reason: "manual_action", detail: "章节测验" } : { ok: true },
    3: engine(video)
  } });
  await controls(worker, "start");
  const current = (await status(worker)).status;
  assert.equal(current.running, false);
  assert.equal(current.phase, "blocked");
  assert.equal(countMessages(worker, "ENGINE_RUN"), 0);
});

test("a replaced reader element with the same identity restarts its frame with the checkpoint", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine(reading) } });
  await controls(worker, "start");
  await progress(worker, reading);
  await worker.request({ type: "ENGINE_CHANGED", candidate: reading, elementReplaced: true }, sender());
  await worker.clock.advance(450);
  await worker.clock.settle(60);
  const runs = worker.messages.filter((item) => item.message.type === "ENGINE_RUN");
  assert.equal(runs.length, 2);
  assert.equal(runs[1].message.checkpoint.elapsedSeconds, 12);
});

test("the same reused iframe media key can run again after the top-level lesson context changes", async () => {
  let contextKey = "lesson-a";
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: (message) => {
      if (message.type === "ENGINE_PROBE") return { candidate: null, reason: "not_found", contextKey, frameOrigins: [] };
      if (message.type === "ENGINE_ADVANCE") { contextKey = "lesson-b"; return { ok: true, clicked: true }; }
      return { ok: true };
    },
    3: engine(video)
  } });
  await controls(worker, "start");
  await progress(worker, video, 3);
  await done(worker, video, 3);
  await worker.clock.advance(4000);
  await worker.clock.settle(60);
  const runs = worker.messages.filter((item) => item.message.type === "ENGINE_RUN");
  assert.equal(runs.length, 2, "a stable iframe URL/key must not make lesson B look already completed");
  assert.equal(runs[1].options.frameId, 3);
  assert.equal(runs[1].message.checkpoint, null, "lesson B must not inherit lesson A's elapsed checkpoint");
  await progress(worker, video, 3);
  assert.equal((await status(worker)).status.phase, "playing");
  await done(worker, video, 3);
  assert.equal((await status(worker)).status.completedCount, 2);
});

test("a manual selection of another task during waiting cancels the previous next click", async () => {
  let selected = video;
  const nextReading = { ...reading, key: "read-manually-selected", title: "手动选择的下一课" };
  const base = engine();
  const worker = createWorker({ frameHandlers: { 0: (message) => message.type === "ENGINE_PROBE" ? { candidate: selected } : base(message) } });
  await controls(worker, "start");
  await progress(worker);
  await done(worker);
  await worker.clock.advance(1000);
  selected = nextReading;
  await worker.request({ type: "ENGINE_CHANGED", candidate: selected }, sender());
  await worker.clock.advance(450);
  await worker.clock.settle(60);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 2);
  assert.equal((await status(worker)).status.title, nextReading.title);
  await worker.clock.advance(10_000);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0, "the old completed task's delayed click must not skip the manually selected task");
});

test("a top-level context selection cancels waiting even when the active iframe key remains unchanged", async () => {
  let contextKey = "lesson-a";
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE" ? { candidate: null, contextKey, frameOrigins: [] } : { ok: true, clicked: true },
    3: engine(video)
  } });
  await controls(worker, "start");
  await progress(worker, video, 3);
  await done(worker, video, 3);
  await worker.clock.advance(1000);
  contextKey = "lesson-b";
  await worker.request({ type: "ENGINE_CHANGED", candidate: null, contextKey }, sender(0));
  await worker.clock.advance(450);
  await worker.clock.settle(60);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 2);
  await worker.clock.advance(10_000);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
  assert.equal((await status(worker)).status.completedCount, 1);
});

test("an all-frame injection failure falls back to the permitted top frame", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  const attempts = [];
  worker.chrome.scripting.executeScript = async ({ target }) => {
    attempts.push(target);
    if (target.allFrames) throw new Error("Cannot access one cross-origin frame");
    return [{ frameId: 0, result: null }];
  };
  const result = await controls(worker, "start");
  assert.equal(result.ok, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(Array.from(attempts[1].frameIds), [0]);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 1);
});

test("cross-origin iframe permission is offered explicitly and registration happens only after grant", async () => {
  const approved = new Set(["https://e.huawei.com/*"]);
  const base = engine();
  const worker = createWorker({ granted: ({ origins }) => origins.every((origin) => approved.has(origin)), frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE" ? { candidate: reading, contextKey: "lesson-a", frameOrigins: ["https://media.huawei.example/player"] } : base(message)
  } });
  await controls(worker, "start");
  assert.deepEqual(Array.from((await status(worker)).connection.additionalOrigins), ["https://media.huawei.example/*"]);
  assert.equal(worker.registrations.length, 1);
  approved.add("https://media.huawei.example/*");
  await controls(worker, "rescan");
  assert.ok(worker.registrations.some((script) => script.matches.includes("https://media.huawei.example/*")));
  assert.deepEqual(Array.from((await status(worker)).connection.additionalOrigins), []);
});

test("initial detection stops after 15 seconds and preserves the page's diagnostic instead of waiting forever", async () => {
  const pageDetail = "当前课时容器 .missing-current-lesson 尚未找到正文";
  const worker = createWorker({ frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE"
      ? { candidate: null, reason: "not_found", detail: pageDetail, frameOrigins: [] }
      : { ok: true }
  } });
  await controls(worker, "start");
  let current = (await status(worker)).status;
  assert.equal(current.phase, "detecting");
  assert.equal(current.running, true);
  assert.match(current.detail, /missing-current-lesson/, "surface the actual probe explanation while loading");
  await worker.clock.advance(14_999);
  assert.equal((await status(worker)).status.phase, "detecting");
  await worker.clock.advance(1);
  await worker.clock.settle(60);
  current = (await status(worker)).status;
  assert.equal(current.phase, "blocked");
  assert.equal(current.running, false);
  assert.match(current.detail, /missing-current-lesson/, "timeout must retain the page-specific failure information");
  const probesAtStop = countMessages(worker, "ENGINE_PROBE");
  await worker.clock.advance(60_000);
  assert.equal(countMessages(worker, "ENGINE_PROBE"), probesAtStop, "an unrecognized page must not retry forever after timing out");
});

test("a missing content-script receiver reports a connection error immediately with refresh guidance", async () => {
  const worker = createWorker({ frameHandlers: {} });
  await controls(worker, "start");
  const current = (await status(worker)).status;
  assert.equal(current.running, false);
  assert.equal(current.phase, "error");
  assert.match(current.detail, /刷新|重新加载/);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 0);
});

test("missing iframe permission blocks with an actionable reason instead of an empty detection spinner", async () => {
  const worker = createWorker({ granted: ({ origins }) => origins.every((origin) => origin === "https://e.huawei.com/*"), frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE"
      ? { candidate: null, reason: "not_found", detail: "需要连接内嵌播放器", frameOrigins: ["https://media.huawei.example/player"] }
      : { ok: true }
  } });
  await controls(worker, "start");
  const result = await status(worker);
  assert.equal(result.status.running, false);
  assert.equal(result.status.phase, "blocked");
  assert.match(result.status.detail, /内嵌|授权/);
  assert.deepEqual(Array.from(result.connection.additionalOrigins), ["https://media.huawei.example/*"]);
  assert.equal(worker.registrations.length, 1, "discovery must not silently grant or register the media origin");
});

test("nested granted iframe surfaces its own ungranted player origin for targeted authorization", async () => {
  const approved = new Set(["https://e.huawei.com/*", "https://shell.huawei.example/*"]);
  const worker = createWorker({ frames: [0, 3], granted: ({ origins }) => origins.every((origin) => approved.has(origin)), frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE"
      ? { candidate: null, reason: "not_found", frameOrigins: ["https://shell.huawei.example/lesson"] }
      : { ok: true },
    3: (message) => message.type === "ENGINE_PROBE"
      ? { candidate: null, reason: "not_found", detail: "嵌套播放器尚未授权", frameOrigins: ["https://video.huawei.example/player"] }
      : { ok: true }
  } });
  await controls(worker, "start");
  const result = await status(worker);
  assert.equal(result.status.phase, "blocked");
  assert.deepEqual(Array.from(result.connection.additionalOrigins), ["https://video.huawei.example/*"], "include discoveries from child frames without re-requesting the approved shell");
  assert.match(result.status.detail, /内嵌|授权/);
});

test("a previously ready iframe stays eligible when later all-frame injection falls back to the top frame", async () => {
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE" ? { candidate: null, frameOrigins: [] } : { ok: true },
    3: engine(video)
  } });
  await controls(worker, "start");
  await progress(worker, video, 3);
  await worker.request({ type: "ENGINE_READY" }, sender(3));
  worker.chrome.scripting.executeScript = async ({ target }) => {
    if (target.allFrames) throw new Error("One unrelated cross-origin frame refused injection");
    return [{ frameId: 0, result: null }];
  };
  await controls(worker, "rescan");
  const runs = worker.messages.filter((item) => item.message.type === "ENGINE_RUN");
  assert.equal(runs.length, 2);
  assert.equal(runs.at(-1).options.frameId, 3, "fallback injection must not erase an existing reachable video frame");
});

test("successful delayed content discovery cancels the old initial detection deadline", async () => {
  let selected = null;
  const base = engine(reading);
  const worker = createWorker({ frameHandlers: {
    0: (message) => message.type === "ENGINE_PROBE"
      ? { candidate: selected, reason: selected ? undefined : "not_found", detail: "课时内容正在加载", frameOrigins: [] }
      : base(message)
  } });
  await controls(worker, "start");
  await worker.clock.advance(8000);
  selected = reading;
  await worker.request({ type: "ENGINE_CHANGED", candidate: reading }, sender());
  await worker.clock.advance(450);
  await worker.clock.settle(60);
  await progress(worker, reading);
  await worker.clock.advance(10_000);
  const current = (await status(worker)).status;
  assert.equal(current.phase, "reading");
  assert.equal(current.running, true);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 1, "polling and the page change event must not start duplicate runners");
});

test("collecting recognition diagnostics does not start an idle page or resume a paused course", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine(reading) } });
  const idle = await worker.request({ type: "GET_DIAGNOSTICS", tabId: 7 });
  assert.equal(idle.ok, true);
  assert.equal(idle.diagnostics.frames[0].responded, true);
  assert.equal(idle.diagnostics.frames[0].candidate.type, "text");
  assert.equal(countMessages(worker, "ENGINE_RUN"), 0);
  assert.equal((await status(worker)).status, null, "diagnostic collection must not create a running session");

  await controls(worker, "start");
  await progress(worker, reading);
  await controls(worker, "pause");
  const paused = await worker.request({ type: "GET_DIAGNOSTICS", tabId: 7 });
  assert.equal(paused.ok, true);
  const current = (await status(worker)).status;
  assert.equal(current.phase, "paused");
  assert.equal(current.running, false);
  assert.equal(countMessages(worker, "ENGINE_RUN"), 1);
});

test("recognition diagnostics respect the current website permission before injecting any script", async () => {
  const worker = createWorker({ granted: false, frameHandlers: { 0: engine() } });
  let injections = 0;
  worker.chrome.scripting.executeScript = async () => { injections += 1; return [{ frameId: 0 }]; };
  const result = await worker.request({ type: "GET_DIAGNOSTICS", tabId: 7 });
  assert.equal(result.ok, false);
  assert.match(result.error, /允许|授权/);
  assert.equal(injections, 0);
});

test("scroll observations reach the popup without creating a reading deadline or completion", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine(reading) } });
  await controls(worker, "start");
  const scroll = { enabled: true, state: "bottom", movements: 9, nextInSeconds: 0, intervalSeconds: 10 };
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: {
    key: reading.key, runId: currentRun(worker), phase: "reading", elapsedSeconds: 9999, remainingSeconds: 30, scroll, detail: "已到底，等待手动切换"
  } }, sender());
  await worker.request({ type: "ENGINE_DONE", key: reading.key, runId: currentRun(worker), taskType: "text" }, sender());
  await worker.clock.advance(120000);
  const current = (await status(worker)).status;
  assert.deepEqual(current.scroll, scroll);
  assert.equal(current.remainingSeconds, 0);
  assert.equal(current.phase, "reading");
  assert.equal(current.completedCount, 0);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
});

test("a centering video remains active through repeated detection and reports its phase", async () => {
  const worker = createWorker({ frames: [0, 3], frameHandlers: { 0: engine(null), 3: engine(video) } });
  await controls(worker, "start");
  await progress(worker, video, 3, "centering");
  await worker.request({ type: "ENGINE_CHANGED", candidate: video }, sender(3));
  await worker.clock.advance(450);
  assert.equal((await status(worker)).status.phase, "centering");
  assert.equal(countMessages(worker, "ENGINE_RUN"), 1);
  assert.ok(worker.messages.filter(item => item.message.type === "ENGINE_PROBE").every(item => item.message.viewportEnabled === true));
});

test("an old reading timer and pending completion are retired when upgrading", async () => {
  const worker = createWorker({ local: { settings: { readSeconds: 120, theme: "dark" } }, session: {
    "itc:tab:7": { tabId: 7, origin: "https://e.huawei.com/*", running: true, phase: "waiting",
      taskType: "text", nextAt: 1_800_000_000_001, checkpoint: { remainingSeconds: 120 }, frameIds: [0] }
  }, frameHandlers: { 0: engine() } });
  await worker.clock.advance(10000);
  await worker.chrome.alarms.onAlarm.dispatch({ name: "itc-watchdog" });
  const current = await status(worker);
  assert.equal(current.status.running, false);
  assert.equal(current.status.phase, "paused");
  assert.equal(current.status.nextAt, null);
  assert.equal(current.settings.scrollIntervalSeconds, 10);
  assert.equal(current.settings.theme, "dark");
  assert.equal("readSeconds" in worker.chrome.storage.local.data.settings, false);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
});

test("restart cancels the pending next click and retires old messages even for the same video", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  const oldRun = currentRun(worker);
  await done(worker);
  await worker.clock.advance(1000);
  assert.equal((await status(worker)).status.completedCount, 1);
  await controls(worker, "restart");
  assert.notEqual(currentRun(worker), oldRun);
  await worker.request({ type: "ENGINE_DONE", key: video.key, taskType: "video", runId: oldRun }, sender());
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: video.key, runId: oldRun, phase: "playing", detail: "old run" } }, sender());
  await worker.clock.advance(5000);
  const current = (await status(worker)).status;
  assert.equal(current.completedCount, 0);
  assert.equal(current.history.length, 0);
  assert.equal(current.nextAt, null);
  assert.equal(current.running, true);
  assert.notEqual(current.detail, "old run");
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
  await done(worker);
  assert.equal((await status(worker)).status.completedCount, 1, "the fresh run can still finish normally");
});

test("restart can start a new current page without a session and recover a stopped page", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine(reading) } });
  assert.equal((await controls(worker, "restart")).ok, true);
  await controls(worker, "stop");
  worker.tabInfo.url = "https://other.huawei.example/course/current";
  assert.equal((await controls(worker, "restart")).ok, true);
  const current = (await status(worker)).status;
  assert.equal(current.url, worker.tabInfo.url);
  assert.equal(current.taskType, "text");
  assert.equal(current.running, true);
});

test("manual selection can return to a previously played lesson without the old completion blocking it", async () => {
  let selected = video;
  const base = engine();
  const worker = createWorker({ frameHandlers: { 0: message => message.type === "ENGINE_PROBE" ? { candidate: selected } : base(message) } });
  await controls(worker, "start");
  await done(worker);
  selected = reading;
  await worker.request({ type: "ENGINE_CHANGED", candidate: reading }, sender());
  await worker.clock.advance(450);
  await progress(worker, reading);
  selected = video;
  await worker.request({ type: "ENGINE_CHANGED", candidate: video }, sender());
  await worker.clock.advance(450);
  assert.equal((await status(worker)).status.running, true);
  assert.equal((await status(worker)).status.taskType, "video");
  assert.equal(countMessages(worker, "ENGINE_RUN"), 3);
  await done(worker);
  assert.equal((await status(worker)).status.completedCount, 2);
});

test("text before an embedded video wins detection and its frame stays available when video takes over", async () => {
  let beforeVideo = true;
  const textFirst = { ...reading, readingBeforeVideo: true, score: 55 };
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: message => message.type === "ENGINE_PROBE" ? { candidate: beforeVideo ? textFirst : null } : { ok: true },
    3: engine({ ...video, score: 999 })
  } });
  await controls(worker, "start");
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).options.frameId, 0);
  await progress(worker, reading);
  beforeVideo = false;
  await worker.request({ type: "ENGINE_CHANGED", candidate: null }, sender());
  await worker.clock.advance(450);
  const runs = worker.messages.filter(item => item.message.type === "ENGINE_RUN");
  assert.equal(runs.at(-1).options.frameId, 3);
  const stopIndex = worker.messages.findLastIndex(item => item.message.type === "ENGINE_STOP" && item.options.frameId === 0);
  assert.ok(worker.messages.slice(stopIndex + 1).some(item => item.message.type === "ENGINE_PROBE" && item.options.frameId === 0 && item.message.viewportEnabled));
});

test("failed restart persists the cancelled old navigation so a worker reload cannot revive it", async () => {
  const worker = createWorker({ frameHandlers: { 0: engine() } });
  await controls(worker, "start");
  await done(worker);
  worker.chrome.scripting.executeScript = async () => { throw new Error("injection unavailable"); };
  assert.equal((await controls(worker, "restart")).ok, false);
  const restarted = createWorker({ session: worker.chrome.storage.session.data, frameHandlers: { 0: engine() } });
  await restarted.clock.advance(10000);
  await restarted.chrome.alarms.onAlarm.dispatch({ name: "itc-watchdog" });
  const current = (await status(restarted)).status;
  assert.equal(current.running, false);
  assert.equal(current.nextAt, null);
  assert.equal(current.phase, "error");
  assert.equal(countMessages(restarted, "ENGINE_ADVANCE"), 0);
});

test("manual revisit while automatic navigation is loading can replay an earlier completed video", async () => {
  const second = { ...video, key: "second-video", title: "第二视频" };
  let selected = video;
  const base = engine();
  const worker = createWorker({ frameHandlers: { 0: message => message.type === "ENGINE_PROBE" ? { candidate: selected } : base(message) } });
  await controls(worker, "start");
  await done(worker);
  selected = second;
  await worker.clock.advance(4000);
  await worker.clock.settle(60);
  await done(worker, second);
  await worker.clock.advance(3000);
  selected = video;
  await worker.request({ type: "ENGINE_CHANGED", candidate: video }, sender());
  await worker.clock.advance(450);
  assert.equal((await status(worker)).status.running, true);
  assert.equal((await status(worker)).status.title, video.title);
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).message.checkpoint, null);
  await done(worker);
  assert.equal((await status(worker)).status.completedCount, 3);
});

test("a page flow keeps task ownership across video segments and advances only on platform completion", async () => {
  const page = { ...reading, flowRoot: true, score: 1 };
  const worker = createWorker({ frames: [0, 3], frameHandlers: { 0: engine(page), 3: engine({ ...video, flowRoot: true, score: 999 }) } });
  await controls(worker, "start");
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).options.frameId, 0);
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).message.resetPosition, true);
  const runId = currentRun(worker);
  const flow = { playedMediaIds: ["segment-one"], videosCompleted: 1 };
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: reading.key, runId, taskType: "video", phase: "playing", flow } }, sender());
  assert.equal((await status(worker)).status.taskType, "video");
  await worker.request({ type: "ENGINE_DONE", key: reading.key, runId, taskType: "video" }, sender());
  await worker.clock.advance(5000);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0, "video ended does not end the page");
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: reading.key, runId, taskType: "text", phase: "waiting_completion", flow } }, sender());
  const current = (await status(worker)).status;
  assert.equal(current.phase, "waiting_completion");
  assert.equal(current.taskType, "text");
  assert.deepEqual(current.flow, flow);
  await done(worker, reading);
  await worker.clock.advance(3000);
  assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 1);
});

test("pause/resume keeps the page flow checkpoint while restart explicitly resets the position", async () => {
  const page = { ...reading, flowRoot: true };
  const flow = { playedMediaIds: ["first-video"], videosCompleted: 1 };
  const base = engine(page);
  const worker = createWorker({ frameHandlers: { 0: message => message.type === "ENGINE_PAUSE"
    ? { ok: true, snapshot: { key: page.key, taskType: "text", elapsedSeconds: 42, flow } } : base(message) } });
  await controls(worker, "start");
  await controls(worker, "pause");
  await controls(worker, "resume");
  let run = worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).message;
  assert.equal(run.resetPosition, false);
  assert.deepEqual(run.checkpoint.flow, flow);
  await controls(worker, "restart");
  run = worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).message;
  assert.equal(run.resetPosition, true);
  assert.equal(run.checkpoint, null);
});

test("embedded segments pair in either order, return to their page owner, and cannot advance the course", async () => {
  for (const readyFirst of [true, false]) {
    const page = { ...reading, flowRoot: true };
    const worker = createWorker({ frames: [0, 3, 4], frameHandlers: { 0: engine(page), 3: engine(video), 4: engine(video) } });
    await controls(worker, "start");
    const runId = currentRun(worker);
    const token = `embedded-token-${readyFirst}`;
    const request = () => worker.request({ type: "ENGINE_EMBEDDED_REQUEST", token, key: page.key, runId, resetPosition: true }, sender());
    const ready = () => worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(3));
    if (readyFirst) { await ready(); await request(); } else { await request(); await ready(); }
    const childRun = worker.messages.filter(item => item.message.type === "ENGINE_EMBEDDED_RUN");
    assert.equal(childRun.length, 1);
    assert.equal(childRun[0].options.frameId, 3);
    await worker.request({ type: "ENGINE_EMBEDDED_DONE", token, runId }, sender(4));
    assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RETURN"), 0, "a sibling cannot finish this segment");
    await worker.request({ type: "ENGINE_EMBEDDED_PROGRESS", token, runId, snapshot: { phase: "playing", taskType: "video" } }, sender(3));
    assert.equal(countMessages(worker, "ENGINE_EMBEDDED_STATUS"), 1);
    await worker.request({ type: "ENGINE_EMBEDDED_DONE", token, runId }, sender(3));
    assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RETURN"), 1);
    assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_EMBEDDED_RETURN")[0].options.frameId, 0);
    assert.equal((await status(worker)).status.completedCount, 0);
    await worker.clock.advance(5000);
    assert.equal(countMessages(worker, "ENGINE_ADVANCE"), 0);
    await controls(worker, "restart");
    await worker.request({ type: "ENGINE_EMBEDDED_DONE", token, runId }, sender(3));
    assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RETURN"), 1, "a return from before restart stays retired");
  }
});

test("the shallowest page flow owns nested course frames even when the top is a wrapper", async () => {
  const page = { ...reading, flowRoot: true, frameDepth: 1, score: 1 };
  const worker = createWorker({ frames: [0, 3, 4], frameHandlers: {
    0: engine(null), 3: engine(page), 4: engine({ ...video, flowRoot: true, frameDepth: 2, score: 999 })
  } });
  await controls(worker, "start");
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_RUN").at(-1).options.frameId, 3);
});

test("an embedded handshake expires and late readiness cannot start the retired child", async () => {
  const page = { ...reading, flowRoot: true };
  const worker = createWorker({ frames: [0, 3], frameHandlers: { 0: engine(page), 3: engine(video) } });
  await controls(worker, "start");
  const runId = currentRun(worker);
  const token = "embedded-expired-token";
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", token, key: page.key, runId }, sender());
  await worker.clock.advance(12000);
  await worker.clock.settle(60);
  const failure = worker.messages.filter(item => item.message.type === "ENGINE_EMBEDDED_RETURN");
  assert.equal(failure.length, 1);
  assert.equal(failure[0].message.ok, false);
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(3));
  assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RUN"), 0);
  assert.equal((await status(worker)).status.completedCount, 0);
});

test("pause cancels the pending embedded handshake deadline", async () => {
  const page = { ...reading, flowRoot: true };
  const worker = createWorker({ frames: [0, 3], frameHandlers: { 0: engine(page), 3: engine(video) } });
  await controls(worker, "start");
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", token: "embedded-paused-token", key: page.key, runId: currentRun(worker) }, sender());
  await controls(worker, "pause");
  await worker.clock.advance(15000);
  assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RETURN"), 0);
  assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RUN"), 0);
});

test("closing a tab retires its pending embedded deadline without reviving storage", async () => {
  const page = { ...reading, flowRoot: true };
  const worker = createWorker({ frames: [0, 3], frameHandlers: { 0: engine(page), 3: engine(video) } });
  await controls(worker, "start");
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", token: "embedded-closed-token", key: page.key, runId: currentRun(worker) }, sender());
  await worker.chrome.tabs.onRemoved.dispatch(7);
  await worker.clock.advance(15000);
  assert.equal(countMessages(worker, "ENGINE_EMBEDDED_RETURN"), 0);
  assert.equal("itc:tab:7" in worker.chrome.storage.session.data, false);
});
