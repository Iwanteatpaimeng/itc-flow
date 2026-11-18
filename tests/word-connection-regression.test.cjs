"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorker } = require("./helpers/worker-harness.cjs");

const page = { type: "text", title: "包含 Word 的教材", key: "book-with-lazy-word", flowRoot: true, frameDepth: 0, score: 160, ready: true };
const word = { type: "document", title: "Word 阅读器", key: "word-inner", flowRoot: true, frameDepth: 1, score: 160, ready: true };
const sender = frameId => ({ tab: { id: 7 }, frameId });
const messagesOf = (worker, type) => worker.messages.filter(item => item.message.type === type);

function fixture({ granted = true } = {}) {
  let wordExists = false, wordInjected = false, injectSucceeds = true;
  const injections = [], bindings = [];
  const worker = createWorker({ frames: [0], granted, frameHandlers: {
    0: message => {
      if (message.type === "ENGINE_PROBE") return { candidate: page, frameOrigins: wordExists ? ["https://dbook.hep.com.cn"] : [], contextKey: "same-course" };
      if (message.type === "ENGINE_EMBEDDED_REBIND") bindings.push(structuredClone(message));
      return { ok: true };
    },
    44: message => {
      if (!wordInjected) throw new Error("Receiving end does not exist");
      return message.type === "ENGINE_PROBE" ? { candidate: word } : { ok: true };
    }
  } });
  worker.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, url: worker.tabInfo.url },
    ...(wordExists ? [{ frameId: 44, parentFrameId: 0, url: "https://dbook.hep.com.cn/word/preview?credential=private-fixture-token" }] : [])
  ];
  worker.chrome.scripting.executeScript = async ({ target }) => {
    injections.push(structuredClone(target));
    if (target.frameIds?.includes(44)) {
      if (!injectSucceeds) throw new Error("Word frame is still loading");
      wordInjected = true;
    }
    return (target.allFrames ? [0] : target.frameIds).map(frameId => ({ frameId }));
  };
  return { worker, injections, bindings, setWordExists(value = true) { wordExists = value; },
    setInjectionSucceeds(value) { injectSucceeds = value; }, setWordInjected(value = true) { wordInjected = value; } };
}

test("an already permitted Word loaded after startup is injected and rebound without restarting its owner", async () => {
  const { worker, bindings, injections, setWordExists } = fixture();
  await worker.request({ type: "CONTROL", tabId: 7, action: "start" });
  const runId = messagesOf(worker, "ENGINE_RUN")[0].message.runId, token = "lazy-word-original-token";
  setWordExists();
  const boundary = worker.messages.length;
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: false }, sender(0));
  assert.ok(injections.some(target => target.frameIds?.includes(44)), "a permitted late Word frame needs its own content engine");
  assert.ok(bindings.some(message => message.token === token && message.runId === runId), "send the original binding again after the receiver has been injected");
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(44));
  const delegated = messagesOf(worker, "ENGINE_EMBEDDED_RUN");
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0].options.frameId, 44);
  assert.equal(delegated[0].message.token, token);
  assert.equal(delegated[0].message.runId, runId);
  assert.equal(delegated[0].message.resetPosition, false);
  assert.equal(messagesOf(worker, "ENGINE_RUN").length, 1);
  assert.equal(worker.messages.slice(boundary).some(item => ["ENGINE_PAUSE", "ENGINE_STOP", "ENGINE_ADVANCE"].includes(item.message.type)), false);
});

test("a late engine-ready event retries the existing unexpired Word binding", async () => {
  const { worker, bindings, setWordExists, setInjectionSucceeds, setWordInjected } = fixture();
  await worker.request({ type: "CONTROL", tabId: 7, action: "start" });
  const runId = messagesOf(worker, "ENGINE_RUN")[0].message.runId, token = "word-engine-late-token";
  setWordExists(); setInjectionSucceeds(false);
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: true }, sender(0));
  const earlierBindings = bindings.length;
  setWordInjected();
  await worker.request({ type: "ENGINE_READY" }, sender(44));
  assert.ok(bindings.length > earlierBindings, "content injection can finish after the initial postMessage, so readiness must ask its actual owner to bind again");
  assert.equal(bindings.at(-1).token, token);
  assert.equal(bindings.at(-1).runId, runId);
  await worker.request({ type: "ENGINE_EMBEDDED_READY", token }, sender(44));
  assert.equal(messagesOf(worker, "ENGINE_EMBEDDED_RUN").length, 1);
  assert.equal(messagesOf(worker, "ENGINE_RUN").length, 1);
});

test("running diagnostics list an unknown unpermitted Word frame without injecting or changing reading state", async () => {
  const { worker, injections, setWordExists } = fixture({ granted: request => request.origins.every(origin => origin === "https://e.huawei.com/*") });
  await worker.request({ type: "CONTROL", tabId: 7, action: "start" });
  const runId = messagesOf(worker, "ENGINE_RUN")[0].message.runId, token = "diagnostic-missing-word";
  setWordExists();
  await worker.request({ type: "ENGINE_EMBEDDED_REQUEST", key: page.key, runId, token, frameOrigin: "https://dbook.hep.com.cn", resetPosition: false }, sender(0));
  const injectionCount = injections.length, boundary = worker.messages.length;
  const response = await worker.request({ type: "GET_DIAGNOSTICS", tabId: 7 });
  assert.equal(response.ok, true);
  const frame = response.diagnostics.frames.find(item => item.frameId === 44);
  assert.ok(frame, "unknown frames must be visible to diagnosis even when the engine never responded");
  assert.equal(frame.origin, "https://dbook.hep.com.cn");
  assert.equal(frame.permission, false);
  assert.equal(frame.known, false);
  assert.equal(frame.responded, false);
  assert.equal(frame.connectionPending, true);
  assert.equal(injections.length, injectionCount, "collecting the diagnosis is read-only while the lesson is active");
  assert.equal(worker.messages.slice(boundary).some(item => ["ENGINE_PAUSE", "ENGINE_STOP", "ENGINE_RUN", "ENGINE_EMBEDDED_REBIND"].includes(item.message.type)), false);
  assert.doesNotMatch(JSON.stringify(response.diagnostics), /private-fixture-token|credential=/);
});
