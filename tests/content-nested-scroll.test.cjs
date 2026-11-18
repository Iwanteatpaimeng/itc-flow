"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element, mediaElement } = require("./helpers/content-harness.cjs");

const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const bottom = node => node.scrollHeight - node.clientHeight;
const movementCount = node => node.scrolls.filter((move, index, all) => move.top > (index ? all[index - 1].top : 0)).length;

function children(parent, nodes) {
  parent.children = nodes;
  for (const node of nodes) node.parentElement = parent;
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function wireQueries(engine, nodes) {
  // Populate only selectors used by this fixture, while preserving the standard
  // harness's task/detection mappings. Real DOM nesting drives order and geometry.
  for (const node of nodes) {
    node.ownerDocument = engine.context.document;
    node.queries.set("*", descendants(node));
    node.queries.set("p,pre,blockquote,[role='document']", descendants(node).filter(item => item.tagName === "P"));
    node.queries.set("p,pre,blockquote,article,[role='document']", descendants(node).filter(item => ["P", "ARTICLE"].includes(item.tagName)));
    node.queries.set("iframe", []);
    node.queries.set("video", descendants(node).filter(item => item.tagName === "VIDEO"));
  }
  engine.mappings.set("*", [...new Set([...engine.nodes, ...nodes])]);
  engine.mappings.delete(".reader-content");
}

function richText(value = "实际正文段落，需要在真实阅读容器内逐步滚动。".repeat(60)) {
  const editor = element("div", value);
  editor.className = "ql-editor";
  editor.clientHeight = editor.scrollHeight = 3000;
  const paragraph = element("p", value);
  paragraph.clientHeight = paragraph.scrollHeight = 3000;
  children(editor, [paragraph]);
  return editor;
}

function hiddenShellLesson() {
  const engine = createContent();
  const shell = element("div", "课程正文".repeat(200));
  shell.className = "learning-content simplebar-wrapper";
  shell.style.overflowY = "hidden";
  shell.scrollHeight = 1600;
  const wrapper = element("div");
  wrapper.className = "simplebar-content-wrapper";
  wrapper.style.overflowY = "auto";
  wrapper.scrollHeight = 3000;
  const editor = richText();
  children(wrapper, [editor]);
  children(shell, [wrapper]);
  children(engine.main, [engine.heading, shell]);
  const root = engine.context.document.scrollingElement;
  root.scrollHeight = 5000;
  wireQueries(engine, [engine.main, shell, wrapper, editor, ...editor.children]);
  engine.mappings.set(".learning-content", [shell]);
  engine.mappings.set(".ql-editor", [editor]);
  return { engine, root, shell, wrapper, editor };
}

test("a hidden broad lesson shell cannot steal scrolling from its nested auto reader", async () => {
  const { engine, root, shell, wrapper } = hiddenShellLesson();
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(4000);
  assert.ok(wrapper.scrollTop > 0, "move the actual simplebar-style reader wrapper");
  assert.equal(shell.scrollTop, 0, "a matching overflow:hidden layout shell must stay still");
  assert.equal(root.scrollTop, 0, "the outer document is outside the lesson reading boundary");
  assert.equal(movementCount(shell), 0);
});

test("nested reading proceeds through inner and middle containers before the shared outer lesson reaches a later video", async () => {
  const engine = createContent();
  const outer = element("section");
  outer.style.overflowY = "auto";
  outer.scrollHeight = 2400;
  const middle = element("section", "中间层后续正文".repeat(80));
  middle.style.overflowY = "auto";
  middle.scrollHeight = 1000;
  const inner = element("div");
  inner.style.overflowY = "auto";
  inner.scrollHeight = 700;
  const editor = richText();
  editor.clientHeight = editor.scrollHeight = 700;
  const middleText = element("p", "内层正文之后仍需阅读的中间层文字".repeat(50));
  middleText.offsetTop = 530;
  const video = mediaElement();
  video.offsetTop = 1300;
  const tail = element("p", "视频之后的外层尾部正文".repeat(50));
  tail.offsetTop = 1800;
  children(inner, [editor]);
  children(middle, [inner, middleText]);
  children(outer, [middle, video, tail]);
  children(engine.main, [engine.heading, outer]);
  const root = engine.context.document.scrollingElement;
  root.scrollHeight = 5000;
  wireQueries(engine, [engine.main, outer, middle, inner, editor, middleText, video, tail, ...editor.children]);
  engine.mappings.set(".ql-editor", [editor]);
  engine.mappings.set("video", [video]);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  for (let step = 0; step < 30 && inner.scrollTop < bottom(inner); step++) {
    await engine.clock.advance(1000);
    assert.equal(outer.scrollTop, 0, "the outer panel cannot skip the inner reader");
    assert.equal(video.playCalls, 0);
  }
  assert.equal(inner.scrollTop, bottom(inner));
  await engine.clock.advance(350);
  for (let step = 0; step < 30 && middle.scrollTop < bottom(middle); step++) {
    await engine.clock.advance(1000);
    assert.equal(outer.scrollTop, 0, "the middle layer's remaining text must be read before moving the common outer boundary");
    assert.equal(video.playCalls, 0);
  }
  assert.equal(middle.scrollTop, bottom(middle));
  for (let step = 0; step < 30 && !video.playCalls; step++) await engine.clock.advance(1000);
  assert.equal(video.playCalls, 1);
  assert.ok(outer.scrollTop > 0);
  assert.equal(root.scrollTop, 0);
});

test("scrollable tools and a course directory inside the same scope do not replace the actual body wrapper", async () => {
  const { engine, root, shell, wrapper } = hiddenShellLesson();
  const tools = element("div", "缩放工具和页码".repeat(70));
  tools.className = "reader-toolbar";
  tools.setAttribute("role", "toolbar");
  tools.style.overflowY = "auto";
  tools.scrollHeight = 6000;
  tools.clientWidth = 1100;
  const nav = element("nav", "课程目录".repeat(70));
  nav.style.overflowY = "auto";
  nav.scrollHeight = 7000;
  children(shell, [tools, nav, wrapper]);
  wireQueries(engine, [engine.main, shell, wrapper, ...descendants(wrapper), tools, nav]);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(5000);
  assert.ok(wrapper.scrollTop > 0);
  assert.equal(tools.scrollTop, 0);
  assert.equal(nav.scrollTop, 0);
  assert.equal(shell.scrollTop, 0);
  assert.equal(root.scrollTop, 0);
});

test("an explicit scroll boundary is independent of the document selector and preserves nested reader order", async () => {
  const { engine, root, shell, wrapper, editor } = hiddenShellLesson();
  engine.mappings.set("#lesson-scroll", [shell]);
  engine.mappings.set("#lesson-document", [editor]);
  const custom = { ...settings, selectors: { document: "#lesson-document", scroll: "#lesson-scroll" } };
  await engine.ask("ENGINE_RUN", { settings: custom, resetPosition: true });
  await engine.clock.advance(5000);
  assert.ok(wrapper.scrollTop > 0, "an explicit enclosing boundary does not bypass its nested scroll reader");
  assert.equal(shell.scrollTop, 0, "the scroll setting names a boundary, while document identifies readable content");
  assert.equal(root.scrollTop, 0);
});
