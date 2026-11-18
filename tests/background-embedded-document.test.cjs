"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorker } = require("./helpers/worker-harness.cjs");

const page = { type: "text", title: "包含 Word 的教材", key: "textbook-with-word", flowRoot: true, frameDepth: 0, score: 160, ready: true };
const word = { type: "document", title: "Word 预览", key: "nested-word", flowRoot: true, frameDepth: 1, score: 160, ready: true };
const sender = frameId => ({ tab: { id: 7 }, frameId });
const messagesOf = (worker, type) => worker.messages.filter(item => item.message.type === type);
const control = (worker, action) => worker.request({ type: "CONTROL", action, tabId: 7 });
const status = worker => worker.request({ type: "POPUP_STATUS", tabId: 7 });

function ownerEngine(extra = {}) {
  let runId;
  return message => {
    if (message.type === "ENGINE_PROBE") return { candidate: page, contextKey: "same-course", frameOrigins: extra.frameOrigins || [] };
    if (message.type === "ENGINE_RUN") { runId = message.runId; return { ok: true }; }
    if (message.type === "ENGINE_PAUSE") return { ok: true, snapshot: { key: page.key, runId, phase: "paused", elapsedSeconds: 41,
      scroll: { movements: 5, state: "paused" }, flow: { playedMediaIds: [], embeddedActive: true, embeddedMediaId: "pending-word" }, ...extra.snapshot } };
    return { ok: true };
  };
}

test("granting Word discovers and injects its previously unknown frame when an unrelated frame rejects all-frame injection", async () => {
  let wordGranted = false;
  const injected = new Set(), attempts = [];
  const worker = createWorker({ frames: [0, 3], granted: request => request.origins.every(origin =>
    origin === "https://e.huawei.com/*" || origin === "https://talent.shixizhi.huawei.com/*" || wordGranted && origin === "https://dbook.hep.com.cn/*"),
  frameHandlers: {
    0: ownerEngine({ frameOrigins: ["https://talent.shixizhi.huawei.com", "https://dbook.hep.com.cn"] }),
    3: message => message.type === "ENGINE_PROBE" ? { reason: "not_found" } : { ok: true },
    44: message => { if (!injected.has(44)) throw new Error("Word script is not injected yet"); return message.type === "ENGINE_PROBE" ? { candidate: word } : { ok: true }; }
  } });
  worker.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, url: worker.tabInfo.url },
    { frameId: 3, parentFrameId: 0, url: "https://talent.shixizhi.huawei.com/course/reader" },
    { frameId: 44, parentFrameId: 0, url: "https://dbook.hep.com.cn/word/preview" },
    { frameId: 99, parentFrameId: 0, url: "https://unrelated.example/widget" }
  ];
  worker.chrome.scripting.executeScript = async ({ target }) => {
    attempts.push(structuredClone(target));
    if (target.allFrames) throw new Error("Cannot access unrelated.example");
    target.frameIds.forEach(id => injected.add(id));
    return target.frameIds.map(frameId => ({ frameId }));
  };
  assert.equal((await control(worker, "start")).ok, true);
  assert.equal(injected.has(44), false, "the ungranted Word origin must be excluded");
  wordGranted = true;
  assert.equal((await control(worker, "rescan")).ok, true);
  assert.equal(injected.has(44), true, "granting must discover Word even though its frame ID was never previously known");
  assert.ok(attempts.some(target => target.frameIds?.includes(44)));
  assert.equal(attempts.some(target => target.frameIds?.includes(99)), false, "an unrelated ungranted frame must never be individually injected");
  assert.ok(messagesOf(worker, "ENGINE_PROBE").some(item => item.options.frameId === 44), "the newly injected Word must join frame probing");
  const runId = messagesOf(worker, "ENGINE_RUN").at(-1).message.runId, token = "newly-authorized-word";
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(44));
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: true }, sender(0));
  const delegated = messagesOf(worker, "ENGINE_EMBEDDED_RUN");
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0].options.frameId, 44);
  assert.equal(delegated[0].message.runId, runId);
});

test("rescan captures fresh pause snapshots from every frame before resuming when no progress event has arrived", async () => {
  const checkpointFlow = { playedMediaIds: ["finished-video"], videosCompleted: 1, embeddedActive: true, embeddedMediaId: "pending-word" };
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: ownerEngine({ snapshot: { elapsedSeconds: 87.5, scroll: { movements: 9, state: "paused" }, flow: checkpointFlow } }),
    3: message => message.type === "ENGINE_PROBE" ? { candidate: { ...word, frameDepth: 1 } } :
      message.type === "ENGINE_PAUSE" ? { ok: true, snapshot: { key: word.key, runId: "different-child", elapsedSeconds: 2 } } : { ok: true }
  } });
  await control(worker, "start");
  const boundary = worker.messages.length;
  assert.equal(messagesOf(worker, "ENGINE_PROGRESS").length, 0);
  assert.equal((await control(worker, "rescan")).ok, true);
  const transition = worker.messages.slice(boundary), paused = transition.filter(item => item.message.type === "ENGINE_PAUSE");
  assert.deepEqual(paused.map(item => item.options.frameId).sort(), [0, 3]);
  const runIndex = transition.findIndex(item => item.message.type === "ENGINE_RUN");
  assert.ok(runIndex > transition.findLastIndex(item => item.message.type === "ENGINE_PAUSE"), "all pause snapshots must precede the new run");
  assert.equal(transition.some(item => item.message.type === "ENGINE_STOP"), false, "rescan must retain each nested engine's checkpoint");
  const resumed = messagesOf(worker, "ENGINE_RUN").at(-1).message;
  assert.equal(resumed.resetPosition, false);
  assert.equal(resumed.checkpoint.elapsedSeconds, 87.5);
  assert.equal(resumed.checkpoint.scroll.movements, 9);
  assert.deepEqual(resumed.checkpoint.flow, checkpointFlow, "the owner's newest pending Word position and completed media must survive");
});

test("an ungranted Word request prompts connection without completing or resetting the textbook", async () => {
  const worker = createWorker({ granted: request => request.origins.every(origin => origin === "https://e.huawei.com/*"), frameHandlers: { 0: ownerEngine() } });
  await control(worker, "start");
  const runId = messagesOf(worker, "ENGINE_RUN")[0].message.runId, token = "ungranted-word-document";
  const boundary = worker.messages.length;
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: true }, sender(0));
  const refusal = messagesOf(worker, "ENGINE_EMBEDDED_RETURN").at(-1).message;
  assert.equal(refusal.ok, false);
  assert.equal(refusal.runId, runId);
  assert.match(refusal.detail, /文档/);
  assert.match(refusal.detail, /连接内嵌内容/);
  assert.match(refusal.detail, /dbook\.hep\.com\.cn/);
  assert.match(refusal.detail, /位置已保留/);
  await worker.request({ type: "ENGINE_EMBEDDED_DONE", token, runId }, sender(44));
  await worker.clock.advance(13000);
  const current = await status(worker);
  assert.deepEqual(Array.from(current.connection.additionalOrigins), ["https://dbook.hep.com.cn/*"]);
  assert.equal(current.status.completedCount, 0);
  assert.equal(current.status.running, true);
  assert.equal(messagesOf(worker, "ENGINE_RUN").length, 1);
  assert.equal(messagesOf(worker, "ENGINE_EMBEDDED_RUN").length, 0);
  assert.equal(worker.messages.slice(boundary).some(item => ["ENGINE_STOP", "ENGINE_PAUSE", "ENGINE_ADVANCE"].includes(item.message.type)), false);
});

test("a ready Word frame that is still rendering retries the original pairing and run until its content is available", async () => {
  let loaded = false;
  const worker = createWorker({ frames: [0, 44], frameHandlers: {
    0: ownerEngine(),
    44: message => message.type === "ENGINE_PROBE" ? loaded ? { candidate: word } : { candidate: null, reason: "not_found", detail: "Word 页面正在加载" } : { ok: true }
  } });
  await control(worker, "start");
  const runId = messagesOf(worker, "ENGINE_RUN")[0].message.runId, token = "loading-word-original-pair";
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(44));
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: true }, sender(0));
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: page.key, runId, phase: "waiting", taskType: "document", flow: { embeddedActive: true } } }, sender(0));
  await worker.clock.advance(1600);
  assert.equal(messagesOf(worker, "ENGINE_EMBEDDED_RUN").length, 0, "do not start and fail an empty rendering surface");
  assert.ok(messagesOf(worker, "ENGINE_PROBE").filter(item => item.options.frameId === 44).length >= 3, "retry content availability through the real handshake");
  assert.equal(messagesOf(worker, "ENGINE_EMBEDDED_RETURN").length, 0);
  loaded = true;
  await worker.clock.advance(600);
  await worker.clock.settle(64);
  const starts = messagesOf(worker, "ENGINE_EMBEDDED_RUN");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].message.runId, runId);
  assert.equal(starts[0].message.token, token);
  assert.equal(messagesOf(worker, "ENGINE_RUN").length, 1, "Word rendering must not restart its textbook owner");
  await worker.request({ type: "ENGINE_EMBEDDED_DONE", token, runId, snapshot: { flow: { videosCompleted: 0 } } }, sender(44));
  const returned = messagesOf(worker, "ENGINE_EMBEDDED_RETURN");
  assert.equal(returned.length, 1);
  assert.equal(returned[0].message.ok, true);
  assert.equal(returned[0].message.token, token);
  assert.equal((await status(worker)).status.completedCount, 0, "reading Word alone does not finish the outer course task");
});
