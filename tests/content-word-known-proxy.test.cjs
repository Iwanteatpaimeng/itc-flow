"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");
const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const append = (parent, children) => { parent.children = children; children.forEach(child => { child.parentElement = parent; }); };
const descendants = parent => parent.children.flatMap(child => [child, ...descendants(child)]);

function fixture({ viewerClass = "document-viewer", externalRail = false } = {}) {
  const engine = createContent({ type: "document" });
  const root = engine.context.document.scrollingElement;
  Object.assign(root, { clientHeight: 600, scrollHeight: 749, scrollTop: 149 });
  engine.context.innerHeight = 600;
  engine.main.offsetTop = 149;
  const viewer = element("div");
  viewer.className = viewerClass;
  Object.assign(viewer, { clientHeight: 550, scrollHeight: 550 });
  const render = element("div");
  Object.assign(render, { clientHeight: 550, scrollHeight: 550 });
  render.style.overflowY = "hidden";
  const canvas = element("canvas");
  Object.assign(canvas, { clientWidth: 760, clientHeight: 550, scrollHeight: 550 });
  const rail = element("div");
  Object.assign(rail, { offsetLeft: 765, clientWidth: 7, clientHeight: 550, scrollHeight: 1900 });
  rail.style.overflowY = "auto";
  const spacer = element("div");
  Object.assign(spacer, { clientWidth: 7, clientHeight: 1900, scrollHeight: 1900 });
  append(root, [engine.main]); append(engine.main, externalRail ? [viewer, rail] : [viewer]);
  append(viewer, externalRail ? [render] : [render, rail]); append(render, [canvas]); append(rail, [spacer]);
  const matches = (node, selector) => selector.split(",").some(raw => {
    const part = raw.trim();
    if (!/^(?:[a-z][\w-]*)?(?:[.#][\w-]+)*$/i.test(part)) return false;
    const tag = part.match(/^[a-z][\w-]*/i)?.[0], id = part.match(/#([\w-]+)/)?.[1];
    return (!tag || node.tagName.toLowerCase() === tag.toLowerCase()) && (!id || node.getAttribute("id") === id) &&
      [...part.matchAll(/\.([\w-]+)/g)].every(match => node.className.split(/\s+/).includes(match[1]));
  });
  for (const node of [root, ...descendants(root)]) {
    node.ownerDocument = engine.context.document;
    node.matches = selector => matches(node, selector);
    node.closest = selector => { for (let current = node; current; current = current.parentElement) if (matches(current, selector)) return current; return null; };
    node.querySelectorAll = selector => descendants(node).filter(child => selector === "*" || matches(child, selector));
  }
  engine.context.document.querySelectorAll = selector => [root, ...descendants(root)].filter(node => selector === "*" || matches(node, selector));
  const parent = {}; engine.context.parent = engine.context.top = parent;
  engine.emitWindow("message", { data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token: "known-word-scroll-proxy" }, source: parent });
  return { engine, root, rail };
}

for (const viewerClass of ["document-viewer", "word-viewer"]) {
  test(`a recognized ${viewerClass} reads its narrow sibling scroll rail before returning to the textbook`, async () => {
    const { engine, root, rail } = fixture({ viewerClass });
    const start = await engine.ask("ENGINE_EMBEDDED_RUN", { token: "known-word-scroll-proxy", settings, runId: "known-word-proxy", resetPosition: true });
    assert.equal(start.ok, true);
    assert.equal(engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false, "recognized viewer classes must not bypass internal proxy discovery and finish immediately");
    await engine.clock.advance(2200);
    assert.ok(rail.scrollTop > 0, "the 7px internal scrolling component must move");
    const paused = await engine.ask("ENGINE_PAUSE"), position = rail.scrollTop;
    await engine.clock.advance(3000);
    assert.equal(rail.scrollTop, position, "pausing holds the Word scrollbar");
    assert.equal(root.scrollTop, 149, "starting and pausing leave the outer viewport fixed");
    const resumed = await engine.ask("ENGINE_EMBEDDED_RUN", { token: "known-word-scroll-proxy", settings, runId: "known-word-proxy-resumed", checkpoint: paused.snapshot, resetPosition: false });
    assert.equal(resumed.ok, true);
    assert.ok(rail.scrollTop >= position);
    for (let step = 0; step < 100 && !engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"); step++) await engine.clock.advance(500);
    assert.equal(rail.scrollTop, rail.scrollHeight - rail.clientHeight, "return only after all internal pages have been traversed");
    assert.equal(engine.outbound.filter(message => message.type === "ENGINE_EMBEDDED_DONE").length, 1);
    assert.equal(root.scrollTop, 149, "completion never scrolls the outer viewport");
  });
}

test("a recognized document viewer cannot pair an adjacent scrollbar outside its content scope", async () => {
  const { engine, root, rail } = fixture({ externalRail: true });
  await engine.ask("ENGINE_EMBEDDED_RUN", { token: "known-word-scroll-proxy", settings, runId: "known-word-unrelated-scroll", resetPosition: true });
  await engine.clock.advance(2200);
  assert.equal(rail.scrollTop, 0, "a nearby external scrollbar is not evidence of the viewer's scrolling component");
  assert.equal(root.scrollTop, 149);
});
