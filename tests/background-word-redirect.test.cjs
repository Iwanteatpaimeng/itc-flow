"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorker } = require("./helpers/worker-harness.cjs");

const page = { type: "text", title: "含重定向 Word 的教材", key: "redirect-book", flowRoot: true, frameDepth: 2, score: 160, ready: true };
const shell = { type: "document", title: "实际文档壳", key: "redirect-shell", flowRoot: true, frameDepth: 3, score: 160, ready: true };
const word = { type: "document", title: "Word 内部阅读器", key: "redirect-office", flowRoot: true, frameDepth: 4, score: 160, ready: true };
const sender = frameId => ({ tab: { id: 7 }, frameId });
const messagesOf = (worker, type) => worker.messages.filter(item => item.message.type === type);
const expectedActual = ["https://urc.hep.com.cn/*", "https://office-cn-beijing.imm.aliyuncs.com/*"];

function fixture({ actualGranted = false, origins = expectedActual } = {}) {
  let exists = false, grantedActual = actualGranted;
  const injected = new Set([0, 11]), attempts = [];
  const allowed = new Set(["https://e.huawei.com/*", "https://talent.shixizhi.huawei.com/*", "https://dbook.hep.com.cn/*"]);
  const actualShell = origins[0].slice(0, -2), actualWord = origins[1].slice(0, -2);
  const worker = createWorker({ frames: [0, 11], granted: request => request.origins.every(origin => allowed.has(origin) || grantedActual && origins.includes(origin)), frameHandlers: {
    0: message => message.type === "ENGINE_PROBE" ? { reason: "not_found", contextKey: "same-course", frameOrigins: ["https://talent.shixizhi.huawei.com"] } : { ok: true },
    11: message => message.type === "ENGINE_PROBE" ? { candidate: page, frameOrigins: exists ? ["https://dbook.hep.com.cn"] : [] } : { ok: true },
    44: message => {
      if (!injected.has(44)) throw new Error("Word shell has no content receiver");
      return message.type === "ENGINE_PROBE" ? { candidate: shell, frameOrigins: [actualWord] } : { ok: true };
    },
    45: message => {
      if (!injected.has(45)) throw new Error("Office viewer has no content receiver");
      return message.type === "ENGINE_PROBE" ? { candidate: word, frameOrigins: [] } : { ok: true };
    }
  } });
  worker.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, url: worker.tabInfo.url },
    { frameId: 11, parentFrameId: 0, url: "https://talent.shixizhi.huawei.com/course/example/course-reader" },
    ...(exists ? [
      { frameId: 44, parentFrameId: 11, url: `${actualShell}/preview?privateToken=secret-fixture` },
      { frameId: 45, parentFrameId: 44, url: `${actualWord}/office/view?signature=secret-fixture` },
      { frameId: 99, parentFrameId: 0, url: "https://unrelated.example/widget" }
    ] : [])
  ];
  worker.chrome.scripting.executeScript = async ({ target }) => {
    attempts.push(structuredClone(target));
    if (target.allFrames) return [0, 11].map(frameId => ({ frameId }));
    target.frameIds.forEach(frameId => injected.add(frameId));
    return target.frameIds.map(frameId => ({ frameId }));
  };
  return { worker, attempts, setExists() { exists = true; }, grantActual() { grantedActual = true; } };
}

async function requestWord(state) {
  await state.worker.request({ type: "CONTROL", tabId: 7, action: "start" });
  state.setExists();
  const runId = messagesOf(state.worker, "ENGINE_RUN")[0].message.runId, token = "redirect-word-original-token";
  await state.worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: false }, sender(11));
  return { runId, token };
}

for (const origins of [expectedActual, ["https://reader.example.test/*", "https://office.example.test/*"]]) {
  test(`redirected Word offers actual document chain origins instead of trusting its src host (${origins[0]})`, async () => {
    const state = fixture({ origins });
    await requestWord(state);
    const response = await state.worker.request({ type: "POPUP_STATUS", tabId: 7 });
    assert.deepEqual(Array.from(response.connection.additionalOrigins).sort(), [...origins].sort(), "the final document and its actual Office child both need targeted authorization");
    assert.equal(state.attempts.some(target => target.frameIds?.some(id => [44, 45, 99].includes(id))), false, "ungranted document or unrelated widgets cannot be injected");
    assert.equal(response.status.completedCount, 0);
    assert.equal(messagesOf(state.worker, "ENGINE_RUN").length, 1);
  });
}

test("a permitted redirect reconnects its actual Word child and the nested viewer with original tokens and run", async () => {
  const state = fixture({ actualGranted: true });
  const { runId, token } = await requestWord(state);
  assert.ok(state.attempts.some(target => target.frameIds?.includes(44)), "an authorized final document origin must not fail the stale iframe-src equality check");
  assert.ok(messagesOf(state.worker, "ENGINE_EMBEDDED_REBIND").some(item => item.options.frameId === 11 && item.message.token === token && item.message.runId === runId));
  await state.worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(44));
  const innerToken = "redirect-office-inner-token";
  await state.worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: shell.key, runId, token: innerToken, frameOrigin: "https://office-cn-beijing.imm.aliyuncs.com", resetPosition: false }, sender(44));
  await state.worker.request({ type: "ENGINE_EMBEDDED_READY", token: innerToken }, sender(45));
  const starts = messagesOf(state.worker, "ENGINE_EMBEDDED_RUN");
  assert.deepEqual(starts.map(item => [item.options.frameId, item.message.token, item.message.runId, item.message.resetPosition]), [[44, token, runId, false], [45, innerToken, runId, false]]);
  assert.equal(messagesOf(state.worker, "ENGINE_RUN").length, 1, "document redirect and nested connection never restart the textbook");
  assert.equal(state.attempts.some(target => target.frameIds?.includes(99)), false, "unrelated outer widgets are outside the requested content branch");
  assert.equal(state.worker.messages.some(item => ["ENGINE_ADVANCE", "ENGINE_PAUSE", "ENGINE_STOP"].includes(item.message.type)), false);
});

test("diagnosing a pending redirected Word associates its final frame without exposing document credentials", async () => {
  const state = fixture();
  await requestWord(state);
  const boundary = state.worker.messages.length, injectionCount = state.attempts.length;
  const response = await state.worker.request({ type: "GET_DIAGNOSTICS", tabId: 7 });
  const frame = response.diagnostics.frames.find(item => item.frameId === 44);
  assert.equal(frame.origin, "https://urc.hep.com.cn");
  assert.equal(frame.permission, false);
  assert.equal(frame.connectionPending, true, "redirecting the iframe cannot hide its current pending connection");
  assert.equal(frame.connectionOwnerFrameId, 11);
  assert.equal(state.attempts.length, injectionCount);
  assert.equal(state.worker.messages.slice(boundary).some(item => ["ENGINE_PAUSE", "ENGINE_STOP", "ENGINE_RUN", "ENGINE_EMBEDDED_REBIND"].includes(item.message.type)), false);
  assert.doesNotMatch(JSON.stringify(response.diagnostics), /secret-fixture|privateToken|signature=/);
});

test("pausing a blocked redirected Word keeps its actual permission choices available", async () => {
  const state = fixture();
  await requestWord(state);
  await state.worker.request({ type: "CONTROL", tabId: 7, action: "pause" });
  const response = await state.worker.request({ type: "POPUP_STATUS", tabId: 7 });
  assert.equal(response.status.phase, "paused");
  assert.deepEqual(Array.from(response.connection.additionalOrigins).sort(), [...expectedActual].sort(), "pausing must not clear the redirected document origins along with its pending handshake");
});

test("granting actual Word origins lets the original pending request retry without changing its owner", async () => {
  const state = fixture();
  const { runId, token } = await requestWord(state);
  state.grantActual();
  await state.worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: false }, sender(11));
  assert.ok(state.attempts.some(target => target.frameIds?.includes(44)));
  await state.worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(44));
  const started = messagesOf(state.worker, "ENGINE_EMBEDDED_RUN");
  assert.equal(started.length, 1);
  assert.equal(started[0].options.frameId, 44);
  assert.equal(started[0].message.token, token);
  assert.equal(started[0].message.runId, runId);
  assert.equal(started[0].message.resetPosition, false);
  assert.equal(messagesOf(state.worker, "ENGINE_RUN").length, 1);
});
