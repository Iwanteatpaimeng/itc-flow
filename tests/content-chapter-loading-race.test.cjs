"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element, mediaElement } = require("./helpers/content-harness.cjs");

function chapterReader({ chapterMenu = false } = {}) {
  const engine = createContent();
  const root = engine.context.document.scrollingElement;
  engine.main.className = "reader-web";
  const host = element("div", "", { id: "reader-container" });
  Object.assign(host, { clientHeight: 664, scrollHeight: 5105, offsetTop: 56 });
  host.style.overflowY = "auto";
  const chapterBox = element("div", "", { id: "reader-chapter-box" });
  Object.assign(chapterBox, { clientHeight: 5020, scrollHeight: 5020 });
  const makeChapter = (id, top, height) => {
    const node = element("div", "教材章节正文。".repeat(100), { id });
    node.className = "reader-chapter-content w-e-text";
    Object.assign(node, { offsetTop: top, clientHeight: height, scrollHeight: height });
    return node;
  };
  const first = makeChapter("chapter-one", 0, 4138), next = makeChapter("chapter-two", 4200, 668);
  const append = (parent, children) => { parent.children = children; children.forEach(child => { child.parentElement = parent; }); };
  append(root, chapterMenu ? [engine.main, engine.catalog] : [engine.main]);
  append(engine.main, [host]); append(host, [chapterBox]); append(chapterBox, [first, next]);
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const compound = (node, selector) => {
    if (!/^(?:[a-z][\w-]*)?(?:[.#][\w-]+)*$/i.test(selector)) return false;
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0], id = selector.match(/#([\w-]+)/)?.[1];
    return (!tag || node.tagName.toLowerCase() === tag.toLowerCase()) && (!id || node.getAttribute("id") === id) &&
      [...selector.matchAll(/\.([\w-]+)/g)].every(match => node.className.split(/\s+/).includes(match[1]));
  };
  const matches = (node, selector) => selector.split(",").some(raw => {
    const parts = raw.trim().split(/\s+/);
    if (!compound(node, parts.pop())) return false;
    let parent = node.parentElement;
    while (parts.length) {
      const part = parts.pop();
      while (parent && !compound(parent, part)) parent = parent.parentElement;
      if (!parent) return false;
      parent = parent.parentElement;
    }
    return true;
  });
  const prepare = node => {
    node.ownerDocument = engine.context.document;
    node.matches = selector => matches(node, selector);
    node.closest = selector => { for (let current = node; current; current = current.parentElement) if (matches(current, selector)) return current; return null; };
    node.querySelectorAll = selector => descendants(node).filter(child => selector === "*" || matches(child, selector));
    return node;
  };
  for (const node of [root, ...descendants(root)]) prepare(node);
  engine.context.document.title = "连续数字教材";
  engine.context.document.querySelectorAll = selector => [root, ...descendants(root)].filter(node => selector === "*" || matches(node, selector));
  const video = (id, top, source) => {
    const node = mediaElement({ id, src: source }); node.className = "insertVideo cres";
    Object.assign(node, { offsetTop: top, clientHeight: 355, scrollHeight: 355 });
    return prepare(node);
  };
  return { engine, root, host, chapterBox, first, next, video, append, prepare, makeChapter };
}

test("a connected chapter emptied just before the reading timer cannot return complete before identity debounce", async () => {
  const { engine, host, first, next } = chapterReader();
  const token = "connected-blank-race", runId = "connected-blank-run";
  const parent = { postMessage() {} };
  engine.context.parent = parent;
  engine.emitWindow("message", { source: parent, data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token } });
  engine.context.parent = engine.context;
  await engine.ask("ENGINE_EMBEDDED_RUN", { token, runId, resetPosition: true, settings: { scrollIntervalSeconds: 1 } });
  await engine.clock.advance(800);
  first.innerText = first.textContent = next.innerText = next.textContent = "";
  first.clientHeight = first.scrollHeight = next.clientHeight = next.scrollHeight = 0;
  host.scrollHeight = host.clientHeight;
  engine.mutate();
  await engine.clock.advance(110); // First 900ms reading timer; identity debounce is still pending until 1350ms.
  assert.equal(first.isConnected, true, "the website retains its chapter element while loading replacement content");
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false,
    "an empty retained node cannot be mistaken for the completed textbook");
  const pending = await engine.ask("ENGINE_PROBE");
  assert.equal(pending.candidate.chapterLoading, true);
  assert.equal(pending.diagnostics.runtime.running, true);
  assert.equal(pending.diagnostics.runtime.scrollState, "loading_chapter");
  assert.equal(host.scrolls.some(item => item.top > 0), false, "no reading step runs through the blank chapter");
  first.innerText = first.textContent = "重新加载的教材文字".repeat(100);
  first.clientHeight = first.scrollHeight = 4138;
  host.scrollHeight = 5105;
  engine.mutate();
  await engine.clock.advance(4000);
  assert.ok(host.scrollTop > 0, "the unchanged embedded run resumes its reading timer after content returns");
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false);
  const latest = engine.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS").at(-1);
  assert.equal(latest.token, token);
  assert.equal(latest.runId, runId);
});

test("an ended event queued by a detached chapter video cannot mark its replacement as already watched", async () => {
  const { engine, first, video, append } = chapterReader();
  const original = video("queued-ended-player", 154.5, "blob:https://example.test/queued-old-player");
  append(first, [original]);
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "queued-ended-run", resetPosition: true });
  await engine.clock.advance(1000);
  assert.equal(original.playCalls, 1);
  original.isConnected = false;
  const replacement = video("queued-ended-player", 154.5, "blob:https://example.test/queued-new-player");
  append(first, [replacement]);
  engine.mutate();
  original.finish(); // The old listener is still installed until the debounced identity check.
  await engine.clock.settle();
  assert.equal(engine.snapshot().flow.videosCompleted, 0, "a detached queued event cannot mark this stable media identity completed");
  await engine.clock.advance(1500);
  assert.equal(replacement.playCalls, 1, "the replacement video still needs to be played in the same chapter");
  assert.equal(engine.snapshot().flow.videosCompleted, 0);
  replacement.finish();
  await engine.clock.advance(2000);
  assert.equal(engine.snapshot().flow.videosCompleted, 1);
  assert.equal(engine.snapshot().runId, "queued-ended-run");
});

