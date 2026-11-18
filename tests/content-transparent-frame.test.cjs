"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

function transport({ viewportHeight = 1104, frameHeight = 720, frameTop = 56, initialScroll = 0, documentHeight = viewportHeight, clipped = false } = {}) {
  const engine = createContent();
  const root = engine.context.document.scrollingElement;
  engine.context.innerHeight = viewportHeight;
  Object.assign(root, { clientHeight: viewportHeight, scrollHeight: documentHeight, scrollTop: initialScroll });
  const shell = element("div");
  Object.assign(shell, { clientHeight: clipped ? 0 : viewportHeight, scrollHeight: viewportHeight, parentElement: root, ownerDocument: engine.context.document });
  shell.style.overflowY = clipped ? "hidden" : "visible";
  const child = createContent();
  child.context.parent = engine.context;
  child.context.top = engine.context;
  child.context.postMessage = message => child.emitWindow("message", { data: message, source: engine.context });
  const frame = element("iframe", "", { src: "https://talent.shixizhi.huawei.com/course/fixture/course-reader" });
  Object.assign(frame, { offsetTop: frameTop, clientHeight: frameHeight, scrollHeight: frameHeight, parentElement: shell,
    contentWindow: child.context, ownerDocument: engine.context.document });
  root.children = [shell]; shell.children = [frame];
  for (const key of ["main", ".reader-content", "[data-task-id].active", ".task-item.active", "main h2"]) engine.mappings.delete(key);
  engine.mappings.set("iframe", [frame]);
  engine.mappings.set("*", [shell, frame]);
  return { engine, root, frame, child };
}

test("a tall transparent course frame delegates a visible reader without resetting or scrolling the outer page", async () => {
  const { engine, root, child } = transport({ viewportHeight: 1308, frameHeight: 1148, frameTop: 250, initialScroll: 116, documentHeight: 1739 });
  const run = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true, runId: "transport-root" });
  assert.equal(run.ok, true);
  assert.equal(run.candidate.frameTransport, true);
  const request = engine.outbound.find(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.ok(request, "the frame is a transport to the actual lesson, not another reading task");
  assert.equal(root.scrollTop, 116, "start must preserve the outer page position");
  assert.equal(root.scrolls.length, 0);
  const childRun = await child.ask("ENGINE_EMBEDDED_RUN", { settings: { scrollIntervalSeconds: 1 }, token: request.token,
    runId: "transport-root", resetPosition: true });
  assert.equal(childRun.ok, true);
  await child.clock.advance(2500);
  await engine.clock.advance(2500);
  assert.ok(child.reader.scrollTop > 0, "only the delegated lesson starts reading");
  assert.equal(root.scrollTop, 116);
  assert.equal(root.scrolls.length, 0);
});

test("an unscrollable middle application delegates its visible reader even when whole-iframe and page centers differ", async () => {
  const { engine, root } = transport();
  const run = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
  assert.equal(run.ok, true);
  assert.equal(run.candidate.frameTransport, true);
  assert.ok(engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"));
  assert.notEqual(engine.snapshot().phase, "blocked", "a wrapper with no scroll range cannot wait for its whole iframe to center");
  assert.equal(root.scrolls.length, 0);
});

test("a transparent shell cannot delegate a reader hidden by a zero-height clipping ancestor", async () => {
  const { engine, root } = transport({ clipped: true });
  const run = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
  assert.equal(run.ok, true);
  assert.equal(run.candidate.frameTransport, true);
  await engine.clock.advance(5000);
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"), false);
  assert.equal(engine.snapshot().phase, "blocked");
  assert.equal(root.scrolls.length, 0);
});
