"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorker } = require("./helpers/worker-harness.cjs");

const sender = frameId => ({ tab: { id: 7 }, frameId });
const page = (key, depth) => ({ type: "document", title: "连续教材", key, ready: true, score: 160, flowRoot: true, frameDepth: depth });

test("a chapter mutation in a delegated reader preserves the active three-frame chain instead of restarting its waiting owner", async () => {
  const candidates = { 0: page("outer-course", 0), 3: page("middle-course", 1), 4: page("textbook-course", 2) };
  const handler = id => message => message.type === "ENGINE_PROBE" ? { candidate: candidates[id] } : { ok: true };
  const worker = createWorker({ frames: [0, 3, 4], frameHandlers: { 0: handler(0), 3: handler(3), 4: handler(4) } });
  assert.equal((await worker.request({ type: "CONTROL", tabId: 7, action: "start" })).ok, true);
  const run = worker.messages.find(item => item.message.type === "ENGINE_RUN").message;
  const bind = async (owner, child, token) => {
    await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", token, key: candidates[owner].key, runId: run.runId, resetPosition: true }, sender(owner));
    await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(child));
  };
  await bind(0, 3, "outer-middle-chapter-token");
  await bind(3, 4, "middle-reader-chapter-token");
  const scroll = { state: "scheduled", movements: 37, nextAt: worker.clock.now() + 10000, sampledAt: worker.clock.now(), intervalSeconds: 10 };
  const flow = { embeddedActive: true, embeddedMediaId: "middle-frame", playedMediaIds: [], videosCompleted: 2 };
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: candidates[0].key, runId: run.runId,
    phase: "waiting", taskType: "text", detail: "内层教材正在阅读下一章节", elapsedSeconds: 370, scroll, flow } }, sender(0));
  const initialRuns = worker.messages.filter(item => item.message.type === "ENGINE_RUN").length;
  const initialEmbeddedRuns = worker.messages.filter(item => item.message.type === "ENGINE_EMBEDDED_RUN").length;
  await worker.request({ type: "ENGINE_CHANGED", candidate: candidates[4], elementReplaced: true, contextKey: "" }, sender(4));
  await worker.clock.advance(1000);
  await worker.clock.settle(100);
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_RUN").length, initialRuns,
    "a reader chapter update must not start the course owner again");
  assert.equal(worker.messages.filter(item => item.message.type === "ENGINE_EMBEDDED_RUN").length, initialEmbeddedRuns,
    "the middle and reader keep their existing bindings and positions");
  const stored = worker.chrome.storage.session.data["itc:tab:7"];
  assert.equal(stored.activeRunId, run.runId, "the run identity remains valid for existing child reports");
  assert.equal(Object.keys(stored.embedded).length, 2, "both established delegation links survive the chapter mutation");
  assert.equal(stored.scroll.movements, 37);
  await worker.request({ type: "ENGINE_EMBEDDED_PROGRESS", token: "middle-reader-chapter-token", runId: run.runId,
    snapshot: { key: candidates[4].key, runId: run.runId, phase: "reading", scroll: { ...scroll, movements: 38 },
      flow: { playedMediaIds: ["chapter-one-video", "chapter-two-video"], videosCompleted: 2 } } }, sender(4));
  const forwarded = worker.messages.filter(item => item.message.type === "ENGINE_EMBEDDED_STATUS").at(-1);
  assert.equal(forwarded?.options.frameId, 3, "progress from the same reader still reaches its existing parent");
  assert.equal(forwarded?.message.snapshot.scroll.movements, 38);
});
