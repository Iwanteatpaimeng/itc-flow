"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorker } = require("./helpers/worker-harness.cjs");

const sender = frameId => ({ tab: { id: 7 }, frameId });
const page = { type: "document", title: "课程外壳", key: "course-shell", flowRoot: true, frameDepth: 0, score: 160, ready: true };
const child = { type: "text", title: "教材章节", key: "textbook-reader", flowRoot: true, frameDepth: 1, score: 160, ready: true };
const messagesOf = (worker, type) => worker.messages.filter(item => item.message.type === type);

function fixture() {
  let contextKey = "course-one";
  const worker = createWorker({ frames: [0, 3], frameHandlers: {
    0: message => message.type === "ENGINE_PROBE" ? { candidate: page, contextKey } : { ok: true },
    3: message => message.type === "ENGINE_PROBE" ? { candidate: child } : { ok: true }
  } });
  return { worker, setContext(value) { contextKey = value; } };
}

async function begin(worker) {
  await worker.request({ type: "CONTROL", action: "start", tabId: 7 });
  return messagesOf(worker, "ENGINE_RUN").at(-1).message.runId;
}

async function waiting(worker, runId) {
  await worker.request({ type: "ENGINE_PROGRESS", snapshot: { key: page.key, runId, phase: "waiting", taskType: "document",
    flow: { embeddedActive: true }, detail: "正在连接教材" } }, sender(0));
}

test("probing while a textbook handshake is pending preserves its original run and pairing token", async () => {
  const { worker } = fixture();
  const runId = await begin(worker), token = "pending-textbook-pairing";
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, resetPosition: true }, sender(0));
  await waiting(worker, runId);
  await worker.request({ type: "ENGINE_CHANGED", candidate: child }, sender(3));
  await worker.clock.advance(700);
  await worker.clock.settle(64);
  assert.equal(messagesOf(worker, "ENGINE_RUN").length, 1, "a layout probe cannot create another owner run");
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(3));
  const runs = messagesOf(worker, "ENGINE_EMBEDDED_RUN");
  assert.equal(runs.length, 1, "the original pending pairing can still start its child exactly once");
  assert.equal(runs[0].message.runId, runId);
  assert.equal(runs[0].message.token, token);
});

test("a true course selection still retires a waiting textbook delegation even when its outer key is reused", async () => {
  const { worker, setContext } = fixture();
  const runId = await begin(worker), token = "old-textbook-pairing";
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(3));
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, resetPosition: true }, sender(0));
  await waiting(worker, runId);
  setContext("course-two");
  await worker.request({ type: "ENGINE_CHANGED", candidate: page, contextKey: "course-two" }, sender(0));
  await worker.clock.advance(700);
  await worker.clock.settle(64);
  const runs = messagesOf(worker, "ENGINE_RUN");
  assert.equal(runs.length, 2);
  assert.notEqual(runs[1].message.runId, runId, "a manual course switch retains its fresh execution boundary");
  assert.equal(runs[1].message.resetPosition, true);
  await worker.request({ type: "ENGINE_EMBEDDED_DONE", token, runId }, sender(3));
  assert.equal(messagesOf(worker, "ENGINE_EMBEDDED_RETURN").length, 0, "the previous course cannot return into its successor");
});
