"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const append = (parent, children) => { parent.children = children; children.forEach(node => { node.parentElement = parent; }); };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

function installTreeQueries(engine) {
  const root = engine.context.document.scrollingElement;
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
  for (const node of [root, ...descendants(root)]) {
    node.ownerDocument = engine.context.document;
    node.matches = selector => matches(node, selector);
    node.closest = selector => { for (let current = node; current; current = current.parentElement) if (matches(current, selector)) return current; return null; };
    node.querySelectorAll = selector => descendants(node).filter(item => selector === "*" || matches(item, selector));
  }
  engine.context.document.querySelectorAll = selector => [root, ...descendants(root)].filter(node => selector === "*" || matches(node, selector));
}

function textbookWithWord(scale = 1) {
  const owner = createContent();
  const root = owner.context.document.scrollingElement;
  Object.assign(root, { clientHeight: 935, scrollHeight: 1384, scrollTop: 149 });
  owner.context.innerHeight = 2200;
  owner.main.className = "reader-web";
  owner.main.offsetTop = 149;
  const host = element("div", "", { id: "reader-container" });
  Object.assign(host, { offsetTop: 56, clientHeight: 664, scrollHeight: 2600 });
  host.style.overflowY = "auto";
  const chapter = element("div", "Word 前后的教材文字。".repeat(150), { id: "chapter-with-word" });
  chapter.className = "reader-chapter-content w-e-text";
  Object.assign(chapter, { clientHeight: 2350, scrollHeight: 2350 });
  const intro = element("p", "Word 前面的教材文字，必须逐段向下阅读。".repeat(50));
  Object.assign(intro, { clientHeight: 900, scrollHeight: 900 });
  const frame = element("iframe", "", { id: "word-embed", src: "https://example.test/local-word-reader" });
  Object.assign(frame, { offsetTop: 900, clientHeight: 660, scrollHeight: 660, contentWindow: { postMessage() {} } });
  const tail = element("p", "Word 读完后继续阅读教材尾文。".repeat(100));
  Object.assign(tail, { offsetTop: 1570, clientHeight: 700, scrollHeight: 700 });
  append(root, [owner.main]); append(owner.main, [host]); append(host, [chapter]); append(chapter, [intro, frame, tail]);
  installTreeQueries(owner);
  // CSS transforms change visual coordinates, but scrollTop remains in layout units.
  // This tests the geometry contract, not any particular Office SDK implementation.
  for (const node of [root, ...descendants(root)]) {
    const nativeRect = node.getBoundingClientRect.bind(node);
    node.offsetWidth = node.clientWidth; node.offsetHeight = node.clientHeight;
    node.getBoundingClientRect = () => {
      const r = nativeRect();
      return { left: r.left * scale, top: r.top * scale, width: r.width * scale, height: r.height * scale,
        right: r.right * scale, bottom: r.bottom * scale };
    };
  }
  return { owner, root, host, frame };
}

for (const scale of [1, 1.2, 1.5, 2]) {
  test(`Word iframe is reached without passing its center in a ${scale}x transformed reading panel`, async () => {
    const { owner, root, host, frame } = textbookWithWord(scale);
    const started = await owner.ask("ENGINE_RUN", { settings, runId: `word-scaled-${scale}`, resetPosition: true });
    assert.equal(started.ok, true);
    for (let step = 0; step < 300 && !owner.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"); step++) await owner.clock.advance(100);
    assert.ok(owner.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"),
      `Word must receive the reading handoff; current state: ${owner.snapshot()?.phase} / ${owner.snapshot()?.detail}`);
    assert.ok(host.scrollTop > 0, "the preceding text is read before Word");
    assert.ok(Math.abs(frame.getBoundingClientRect().top + frame.getBoundingClientRect().height / 2 -
      (host.getBoundingClientRect().top + host.getBoundingClientRect().height / 2)) <= 2 * scale + 0.01,
      "the near-equal-height Word frame is centered before delegation");
    assert.equal(root.scrollTop, 149, "the surrounding webpage must remain fixed");
  });
}

function wordWithSiblingScroll({ catalogEvidence = null, textEvidence = false } = {}) {
  const child = createContent({ type: "document" });
  const root = child.context.document.scrollingElement;
  Object.assign(root, { clientHeight: 600, scrollHeight: 600 });
  child.context.innerHeight = 600;
  const viewer = element("div");
  Object.assign(viewer, { clientHeight: 600, scrollHeight: 600 });
  const renderLayer = element(catalogEvidence === "nav" ? "nav" : "div");
  if (catalogEvidence && catalogEvidence !== "nav") renderLayer.className = catalogEvidence;
  Object.assign(renderLayer, { clientHeight: 550, scrollHeight: 550 });
  renderLayer.style.overflowY = "hidden";
  const canvas = element(textEvidence ? "p" : "canvas", textEvidence ? "目录条目，不能冒充文档正文。".repeat(30) : "");
  // Virtualized viewers can paint only the visible page region while the
  // independent scrolling component represents the full document height.
  Object.assign(canvas, { clientHeight: 550, scrollHeight: 550 });
  const scroller = element("div");
  Object.assign(scroller, { clientHeight: 550, scrollHeight: 1900 });
  scroller.style.overflowY = "auto";
  const spacer = element("div");
  Object.assign(spacer, { clientHeight: 1900, scrollHeight: 1900 });
  append(root, [child.main]); append(child.main, [viewer]); append(viewer, [renderLayer, scroller]);
  append(renderLayer, [canvas]); append(scroller, [spacer]);
  installTreeQueries(child);
  const bind = () => {
    const parent = {}; child.context.parent = child.context.top = parent;
    child.emitWindow("message", { data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token: "sibling-word-scroll" }, source: parent });
  };
  return { child, root, viewer, renderLayer, scroller, bind };
}

test("a bound generic Word viewer recognizes its sibling scrolling component beside its rendering layer", async () => {
  const { child, root, scroller, bind } = wordWithSiblingScroll();
  const unbound = await child.ask("ENGINE_PROBE", { settings });
  assert.equal(unbound.candidate, null, "generic page evidence is only trusted after the actual parent binds this frame");
  bind();
  const started = await child.ask("ENGINE_EMBEDDED_RUN", { token: "sibling-word-scroll", settings, runId: "word-sibling-scroll", resetPosition: true });
  assert.equal(started.ok, true, "a canvas rendering layer and adjacent scroll proxy belong to one bounded Word viewer");
  await child.clock.advance(2000);
  assert.ok(scroller.scrollTop > 0, "the real internal scrolling component must advance");
  assert.equal(root.scrollTop, 0, "do not substitute scrolling the outer Word frame");
});

for (const catalogEvidence of ["nav", "document-outline", "reader-catalog"]) {
  for (const textEvidence of [false, true]) {
    test(`a bound Word scroll proxy rejects ${textEvidence ? "text" : "canvas"} evidence inside ${catalogEvidence}`, async () => {
      const { child, root, scroller, bind } = wordWithSiblingScroll({ catalogEvidence, textEvidence });
      assert.equal((await child.ask("ENGINE_PROBE", { settings })).candidate, null, "an unbound generic shell is never a Word reader");
      bind();
      const started = await child.ask("ENGINE_EMBEDDED_RUN", { token: "sibling-word-scroll", settings, runId: "word-outline-proxy", resetPosition: true });
      assert.equal(started.ok, false, "catalog or outline render evidence cannot authorize its sibling scroll proxy");
      await child.clock.advance(2000);
      assert.equal(scroller.scrollTop, 0, "do not scroll a component validated only by catalog evidence");
      assert.equal(root.scrollTop, 0, "do not fall back to the outer page");
    });
  }
}

async function activeWordHandoff() {
  const state = textbookWithWord();
  state.messages = [];
  state.frame.contentWindow.postMessage = message => state.messages.push(structuredClone(message));
  await state.owner.ask("ENGINE_RUN", { settings, runId: "word-rebind-current", resetPosition: true });
  for (let step = 0; step < 300 && !state.owner.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"); step++) await state.owner.clock.advance(100);
  state.request = state.owner.outbound.find(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.ok(state.request, "the initial Word handoff must be active");
  return state;
}

test("retrying the current Word binding resends flow-bind without moving or restarting either surface", async () => {
  const { owner, root, host, messages, request } = await activeWordHandoff();
  const textbookPosition = host.scrollTop, outerPosition = root.scrollTop;
  const hostScrolls = host.scrolls.length, outerScrolls = root.scrolls.length, previousMessages = messages.length;
  const rebound = await owner.ask("ENGINE_EMBEDDED_REBIND", { runId: request.runId, token: request.token });
  assert.equal(rebound.ok, true);
  assert.equal(messages.length, previousMessages + 1);
  assert.deepEqual(messages.at(-1), { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token: request.token });
  assert.equal(owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length, 1, "retry must not create a new resetPosition request");
  assert.equal(host.scrollTop, textbookPosition);
  assert.equal(root.scrollTop, outerPosition);
  assert.equal(host.scrolls.length, hostScrolls, "retry must not recenter or reset the textbook");
  assert.equal(root.scrolls.length, outerScrolls);
  assert.equal(owner.snapshot().flow.embeddedActive, true);
});

for (const invalid of ["stale-token", "stale-run", "paused"]) {
  test(`Word binding retry rejects ${invalid} without sending another flow-bind`, async () => {
    const { owner, root, host, messages, request } = await activeWordHandoff();
    if (invalid === "paused") await owner.ask("ENGINE_PAUSE");
    const count = messages.length, hostPosition = host.scrollTop, outerPosition = root.scrollTop;
    const rebound = await owner.ask("ENGINE_EMBEDDED_REBIND", {
      runId: invalid === "stale-run" ? "previous-word-run" : request.runId,
      token: invalid === "stale-token" ? "previous-word-token" : request.token
    });
    assert.equal(rebound.ok, false);
    assert.equal(messages.length, count);
    assert.equal(host.scrollTop, hostPosition);
    assert.equal(root.scrollTop, outerPosition);
  });
}
