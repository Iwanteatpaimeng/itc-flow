"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

function append(parent, children) {
  parent.children = children;
  for (const child of children) child.parentElement = parent;
}

function textbookPlayer({ collapsed = false, includeTail = false, complete = false } = {}) {
  const engine = createContent({ type: "video" });
  const root = engine.context.document.scrollingElement;
  engine.context.innerHeight = 720;
  Object.assign(root, { clientHeight: 720, scrollHeight: 720 });
  const web = element("div"); web.className = "reader-web";
  Object.assign(web, { clientHeight: 720, scrollHeight: 720 });
  const host = element("div", "", { id: "reader-container" }); host.className = "reader-container";
  Object.assign(host, { offsetTop: 56, clientHeight: 664, scrollHeight: 2000 });
  host.style.overflowY = "auto";
  const clip = element("span"); clip.className = "element-new";
  Object.assign(clip, { offsetTop: 154.5, clientHeight: collapsed ? 0 : 355, scrollHeight: 355 });
  clip.style.overflowY = "hidden";
  engine.media.className = "insertVideo cres";
  Object.assign(engine.media, { offsetTop: 0, clientHeight: 355, scrollHeight: 355 });
  const tail = element("p", "这是视频结束后仍需完整显示的最后一段教材文字。".repeat(10));
  Object.assign(tail, { offsetTop: 1850, clientHeight: 150, scrollHeight: 150 });
  const marker = element("strong", "平台确认当前任务完成", { id: "local-textbook-complete" });
  append(clip, [engine.media]); append(host, [clip, ...(includeTail ? [tail] : []), ...(complete ? [marker] : [])]);
  append(web, [host]); append(root, [web]);
  const nodes = [root, web, host, clip, engine.media, ...(includeTail ? [tail] : []), ...(complete ? [marker] : [])];
  const matches = (node, selector) => selector.split(",").some(raw => {
    const value = raw.trim();
    return value === node.tagName.toLowerCase() || value === "#reader-container" && node === host ||
      value === ".reader-web" && node === web || value === "video.insertVideo" && node === engine.media ||
      value === ".element-new" && node === clip;
  });
  for (const node of nodes) {
    node.ownerDocument = engine.context.document;
    node.matches = selector => matches(node, selector);
    node.closest = selector => {
      for (let current = node; current; current = current.parentElement) if (matches(current, selector)) return current;
      return null;
    };
    node.querySelectorAll = selector => selector === "*" ? node.children.flatMap(child => [child, ...child.querySelectorAll("*")]) : [];
  }
  engine.context.document.querySelectorAll = selector => {
    if (selector === "*") return nodes;
    if (selector === "video") return [engine.media];
    if (selector === ".reader-web #reader-container" || selector === "#reader-container") return [host];
    if (selector === "#local-textbook-complete") return complete ? [marker] : [];
    return [];
  };
  engine.context.document.title = "Local textbook player";
  return { engine, root, host, clip, tail };
}

function parentFrame(child, { viewportHeight, documentHeight, frameHeight, frameTop, initialScroll = 0, scaleX = 1, scaleY = 1 }) {
  const engine = createContent();
  const root = engine.context.document.scrollingElement;
  engine.context.innerHeight = viewportHeight;
  Object.assign(root, { clientHeight: viewportHeight, scrollHeight: documentHeight, scrollTop: initialScroll });
  const frame = element("iframe", "", { src: "https://talent.shixizhi.huawei.com/local-textbook-reader" });
  Object.assign(frame, { offsetTop: frameTop, clientHeight: frameHeight, clientWidth: 1200,
    ownerDocument: engine.context.document, contentWindow: child.context });
  if (scaleX !== 1 || scaleY !== 1) {
    Object.assign(frame, { offsetWidth: frame.clientWidth, offsetHeight: frame.clientHeight });
    const rectangle = frame.getBoundingClientRect.bind(frame);
    frame.getBoundingClientRect = () => {
      const rect = rectangle();
      return { ...rect, width: rect.width * scaleX, height: rect.height * scaleY,
        right: rect.left + rect.width * scaleX, bottom: rect.top + rect.height * scaleY };
    };
  }
  append(root, [frame]);
  engine.context.document.querySelectorAll = selector => selector === "*" || selector === "iframe" ? [frame] : [];
  return { engine, root, frame };
}

async function advanceTogether({ child, middle, outer }, milliseconds) {
  for (let step = 0; step < milliseconds / 250; step++) {
    for (const engine of [outer.engine, middle.engine, child.engine]) await engine.clock.advance(250);
  }
}

async function fixture({ offscreen = false, collapsed = false, outerFrameTop = 300, scaleX = 1, scaleY = 1,
  embedded = false, includeTail = false, complete = false } = {}) {
  const child = textbookPlayer({ collapsed, includeTail, complete });
  const middle = parentFrame(child.engine, { viewportHeight: 1104, documentHeight: 1104, frameHeight: 720, frameTop: 200 });
  const outer = parentFrame(middle.engine, { viewportHeight: 1308, documentHeight: offscreen ? 4000 : 1739,
    frameHeight: 1148, frameTop: offscreen ? 2200 : outerFrameTop, initialScroll: 116, scaleX, scaleY });
  outer.engine.context.postMessage = message => outer.engine.emitWindow("message", { data: message, source: middle.engine.context });
  middle.engine.context.postMessage = message => middle.engine.emitWindow("message", {
    data: message, source: message.kind === "request" ? child.engine.context : outer.engine.context
  });
  child.engine.context.postMessage = message => child.engine.emitWindow("message", { data: message, source: middle.engine.context });
  middle.engine.context.parent = outer.engine.context;
  middle.engine.context.top = outer.engine.context;
  child.engine.context.parent = middle.engine.context;
  child.engine.context.top = outer.engine.context;
  await outer.engine.ask("ENGINE_PROBE", { viewportEnabled: true });
  await middle.engine.ask("ENGINE_PROBE", { viewportEnabled: true });
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true,
    selectors: complete ? { completed: "#local-textbook-complete" } : {} };
  const token = "local-frame-port-run";
  if (embedded) {
    child.engine.emitWindow("message", { source: middle.engine.context,
      data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token } });
  }
  const run = await child.engine.ask(embedded ? "ENGINE_EMBEDDED_RUN" : "ENGINE_RUN",
    { settings, token, runId: "local-frame-port", resetPosition: true });
  assert.equal(run.ok, true);
  await advanceTogether({ child, middle, outer }, 16000);
  return { child, middle, outer };
}

test("a visible textbook player uses its actual nested reading viewport without scrolling the surrounding webpage", async () => {
  const { child, middle, outer } = await fixture();
  assert.equal(child.engine.media.playCalls, 1, "a player centered in the visible textbook reader must be allowed to play");
  assert.equal(child.host.scrollTop, 0, "an already centered player needs no reading adjustment");
  assert.equal(middle.root.scrollTop, 0, "the iframe wrapper is only transport");
  assert.equal(outer.root.scrollTop, 116, "the browser document must keep its original position");
  assert.equal(outer.root.scrolls.length, 0, "do not scroll the webpage to force the textbook viewport into the whole-screen center");
});

test("a textbook iframe outside the visible browser viewport cannot start playback or move the webpage", async () => {
  const { child, middle, outer } = await fixture({ offscreen: true });
  assert.equal(child.engine.media.playCalls, 0, "local reader centering alone cannot authorize an offscreen iframe");
  assert.equal(middle.root.scrollTop, 0);
  assert.equal(outer.root.scrollTop, 116);
  assert.equal(outer.root.scrolls.length, 0);
});

test("a zero-height textbook video clip still blocks playback without moving its surrounding webpage", async () => {
  const { child, outer } = await fixture({ collapsed: true });
  assert.equal(child.engine.media.playCalls, 0, "a folded player's actual zero-height clipping layer remains authoritative");
  assert.equal(outer.root.scrollTop, 116);
  assert.equal(outer.root.scrolls.length, 0);
});

for (const { label, outerFrameTop, scaleX, scaleY } of [
  { label: "unscaled", outerFrameTop: 750, scaleX: 1, scaleY: 1 },
  { label: "scaled", outerFrameTop: 900, scaleX: 0.85, scaleY: 0.75 }
]) test(`a partially visible ${label} textbook adjusts only its own reader to the browser-visible reading center`, async () => {
  const { child, middle, outer } = await fixture({ outerFrameTop, scaleX, scaleY });
  assert.equal(child.engine.media.playCalls, 1, "the clipped reader still has enough visible height to show and play the video");
  assert.ok(child.host.scrollTop > 0, "the reader itself compensates for the ancestor viewport clipping");
  assert.equal(middle.root.scrolls.length, 0, "do not move the intermediate webpage");
  assert.equal(outer.root.scrollTop, 116, "do not move the browser document");
  assert.equal(outer.root.scrolls.length, 0);
  const outerBounds = outer.frame.getBoundingClientRect();
  const outerFactor = outerBounds.height / middle.engine.context.innerHeight;
  const middleBounds = middle.frame.getBoundingClientRect();
  const mediaBounds = child.engine.media.getBoundingClientRect();
  const hostBounds = child.host.getBoundingClientRect();
  const readingTop = Math.max(0, outerBounds.top + (middleBounds.top + hostBounds.top) * outerFactor);
  const readingBottom = Math.min(outer.engine.context.innerHeight,
    outerBounds.top + (middleBounds.top + hostBounds.bottom) * outerFactor);
  const mediaCenter = outerBounds.top + (middleBounds.top + mediaBounds.top + mediaBounds.height / 2) * outerFactor;
  const tolerance = Math.max(24, Math.min(80, (readingBottom - readingTop) * 0.1));
  assert.ok(Math.abs(mediaCenter - (readingTop + readingBottom) / 2) <= tolerance,
    "playback uses the visible nested reading area, including the ancestor scale");
  assert.ok(outerBounds.top + (middleBounds.top + mediaBounds.top) * outerFactor >= readingTop - 2,
    "the player's top remains inside the browser-visible reading area");
  assert.ok(outerBounds.top + (middleBounds.top + mediaBounds.bottom) * outerFactor <= readingBottom + 2,
    "the player's bottom remains inside the browser-visible reading area");
});

test("a confirmed textbook viewport must be checked again before reading resumes after its video", async () => {
  const state = await fixture();
  const { child, middle, outer } = state;
  assert.equal(child.engine.media.playCalls, 1);
  const before = child.host.scrollTop;
  const scrollCount = child.host.scrolls.length;
  outer.frame.offsetTop = 2200;
  child.engine.media.finish();
  await advanceTogether(state, 8000);
  assert.equal(child.host.scrollTop, before, "a cached successful viewport check cannot authorize reading while the iframe is offscreen");
  assert.equal(child.host.scrolls.length, scrollCount, "no reading step runs before confirming the changed ancestor viewport");
  assert.equal(child.engine.snapshot().phase, "blocked");
  assert.equal(middle.root.scrolls.length, 0);
  assert.equal(outer.root.scrollTop, 116);
  assert.equal(outer.root.scrolls.length, 0);
  outer.frame.offsetTop = 300;
  await advanceTogether(state, 8000);
  assert.ok(child.host.scrollTop > before, "reading resumes in the same inner host after the user makes the course visible again");
  assert.equal(child.engine.media.playCalls, 1, "resuming the reading area does not replay the completed video");
  assert.equal(middle.root.scrolls.length, 0);
  assert.equal(outer.root.scrollTop, 116);
  assert.equal(outer.root.scrolls.length, 0);
});

for (const embedded of [false, true]) test(`a clipped textbook cannot ${embedded ? "return to its parent" : "complete the task"} with its final paragraph still outside the browser viewport`, async () => {
  const state = await fixture({ outerFrameTop: 750, embedded, includeTail: true, complete: true });
  const { child, middle, outer } = state;
  assert.equal(child.engine.media.playCalls, 1);
  child.engine.media.finish();
  await advanceTogether(state, 40000);
  assert.equal(child.host.scrollTop, child.host.scrollHeight - child.host.clientHeight,
    "the inner scrollbar reaches its own limit");
  const tail = child.tail.getBoundingClientRect();
  const projectedBottom = outer.frame.getBoundingClientRect().top +
    (middle.frame.getBoundingClientRect().top + tail.bottom) * outer.frame.clientHeight / middle.engine.context.innerHeight;
  assert.ok(projectedBottom > outer.engine.context.innerHeight,
    "the final paragraph really is still below the browser-visible viewport at that limit");
  const snapshot = child.engine.outbound.filter(message => message.type === (embedded ? "ENGINE_EMBEDDED_PROGRESS" : "ENGINE_PROGRESS")).at(-1)?.snapshot;
  assert.equal(snapshot?.phase, "blocked", "report the clipped tail explicitly rather than implying the task has been read");
  assert.match(snapshot.detail, /(?:尾|完整|底部|末尾|遮挡|裁剪|可见)/);
  assert.equal(child.engine.outbound.some(message => ["ENGINE_DONE", "ENGINE_EMBEDDED_DONE"].includes(message.type)), false,
    "neither a platform completion marker nor the embedded return path can bypass the unseen tail");
  assert.equal(middle.root.scrolls.length, 0);
  assert.equal(outer.root.scrollTop, 116);
  assert.equal(outer.root.scrolls.length, 0);
  outer.frame.offsetTop = 300;
  await advanceTogether(state, 8000);
  assert.equal(child.engine.outbound.some(message => message.type === (embedded ? "ENGINE_EMBEDDED_DONE" : "ENGINE_DONE")), true,
    "the actual visibility change allows the already reached tail to finish normally");
  assert.equal(outer.root.scrollTop, 116);
  assert.equal(outer.root.scrolls.length, 0);
});
