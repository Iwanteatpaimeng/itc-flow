"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

function parentFrame(child, { viewportHeight, documentHeight, frameHeight, frameTop, initialScroll = 0 }) {
  const engine = createContent();
  engine.reader.innerText = engine.reader.textContent = "";
  engine.context.innerHeight = viewportHeight;
  const root = engine.context.document.scrollingElement;
  Object.assign(root, { clientHeight: viewportHeight, scrollHeight: documentHeight, scrollTop: initialScroll });
  const body = element("body");
  Object.assign(body, { clientHeight: viewportHeight, scrollHeight: documentHeight, parentElement: root, ownerDocument: engine.context.document });
  body.style.overflowY = "auto";
  // Browsers can propagate BODY overflow to the viewport: BODY's dimensions
  // describe the page, while only document.scrollingElement responds to scrolling.
  body.scrollTo = function (options) { this.scrolls.push({ ...options }); };
  const frame = element("iframe", "", { src: "https://talent.shixizhi.huawei.com/local-frame" });
  Object.assign(frame, { offsetTop: frameTop, clientHeight: frameHeight, clientWidth: 1200,
    parentElement: body, contentWindow: child.context, ownerDocument: engine.context.document });
  body.children = [frame]; root.children = [body];
  engine.mappings.set("iframe", [frame]);
  engine.mappings.set("*", [body, frame]);
  return { engine, root, body, frame };
}

async function advanceTogether(engines, seconds = 20) {
  for (let step = 0; step < seconds * 2; step++) {
    for (const engine of engines) await engine.clock.advance(500);
  }
}

test("two ancestor frames align the real viewport when BODY overflow is propagated to the document root", async () => {
  const child = createContent({ type: "video", mediaTop: 169.5 });
  child.context.innerHeight = 720;
  child.media.clientHeight = 381;
  const middle = parentFrame(child, { viewportHeight: 756, documentHeight: 863, frameHeight: 720, frameTop: 130 });
  const outer = parentFrame(middle.engine, { viewportHeight: 935, documentHeight: 1384, frameHeight: 800, frameTop: 300, initialScroll: 127 });
  outer.engine.context.postMessage = message => outer.engine.emitWindow("message", { data: message, source: middle.engine.context });
  middle.engine.context.postMessage = message => middle.engine.emitWindow("message", {
    data: message, source: message.kind === "request" ? child.context : outer.engine.context
  });
  child.context.postMessage = message => child.emitWindow("message", { data: message, source: middle.engine.context });
  middle.engine.context.parent = outer.engine.context;
  middle.engine.context.top = outer.engine.context;
  child.context.parent = middle.engine.context;
  child.context.top = outer.engine.context;
  await outer.engine.ask("ENGINE_PROBE", { viewportEnabled: true });
  await middle.engine.ask("ENGINE_PROBE", { viewportEnabled: true });
  await child.ask("ENGINE_RUN");
  await advanceTogether([outer.engine, middle.engine, child]);
  assert.equal(child.media.playCalls, 1, "a locally centered player must get real ancestor viewport confirmation");
  assert.ok(middle.root.scrollTop > 0, "scroll the intermediate document's actual viewport root");
  assert.ok(outer.root.scrollTop > 127, "align the projected player in the outer browser viewport");
  assert.equal(middle.body.scrollTop, 0);
  assert.equal(outer.body.scrollTop, 0);
  const childCenter = child.media.getBoundingClientRect().top + child.media.clientHeight / 2;
  const intermediateCenter = middle.frame.getBoundingClientRect().top + childCenter;
  const browserCenter = outer.frame.getBoundingClientRect().top + intermediateCenter * outer.frame.clientHeight / middle.engine.context.innerHeight;
  assert.ok(Math.abs(browserCenter - outer.engine.context.innerHeight / 2) <= 80, "playback still requires the actual browser-visible center");
});

test("ancestor alignment keeps an independent course scroll port as its boundary", async () => {
  const child = createContent({ type: "video" });
  const parent = createContent();
  parent.reader.innerText = parent.reader.textContent = "";
  const root = parent.context.document.scrollingElement;
  root.scrollHeight = 5000;
  root.scrollTop = 180;
  const panel = element("section");
  Object.assign(panel, { offsetTop: 380, clientHeight: 500, scrollHeight: 2000, parentElement: root,
    ownerDocument: parent.context.document });
  panel.style.overflowY = "auto";
  const frame = element("iframe", "", { src: "https://talent.shixizhi.huawei.com/local-player" });
  Object.assign(frame, { offsetTop: 800, clientHeight: 900, clientWidth: 1200, parentElement: panel,
    contentWindow: child.context, ownerDocument: parent.context.document });
  panel.children = [frame]; root.children = [panel];
  parent.mappings.set("iframe", [frame]);
  parent.mappings.set("*", [panel, frame]);
  parent.context.postMessage = message => parent.emitWindow("message", { data: message, source: child.context });
  child.context.postMessage = message => child.emitWindow("message", { data: message, source: parent.context });
  child.context.parent = parent.context;
  child.context.top = parent.context;
  await parent.ask("ENGINE_PROBE", { viewportEnabled: true });
  await child.ask("ENGINE_RUN");
  await advanceTogether([parent, child], 10);
  assert.equal(child.media.playCalls, 1);
  assert.ok(panel.scrollTop > 0, "align within the real independent course panel");
  assert.equal(root.scrollTop, 180, "do not move the outer page through a course panel boundary");
});
