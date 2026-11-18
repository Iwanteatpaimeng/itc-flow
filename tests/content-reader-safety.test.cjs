"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

function textbookWithCode(customClass = "") {
  const engine = createContent();
  const doc = engine.context.document, root = doc.scrollingElement;
  Object.assign(root, { clientHeight: 1308, scrollHeight: 1739, scrollTop: 116 });
  engine.context.innerHeight = 1308;
  engine.main.className = "reader-web";
  engine.main.offsetTop = 172;
  const host = element("div", "", { id: "reader-container" });
  host.className = "reader-container";
  host.style.overflowY = "auto";
  Object.assign(host, { clientHeight: 664, scrollHeight: 19009, scrollTop: 40, parentElement: engine.main });
  engine.reader.className = "reader-chapter-content w-e-text";
  engine.reader.style.overflowY = "visible";
  Object.assign(engine.reader, { clientHeight: 18924, scrollHeight: 18924, parentElement: host });
  const code = element("pre", "一个局部代码示例".repeat(60));
  code.className = customClass;
  code.style.overflowY = "auto";
  Object.assign(code, { offsetTop: 240, clientHeight: 36, scrollHeight: 482, scrollTop: 100, parentElement: engine.reader });
  engine.reader.children = [code];
  host.children = [engine.reader];
  engine.main.children = [host];
  const nodes = [root, engine.main, host, engine.reader, code];
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const simple = (node, raw) => {
    const selector = raw.trim();
    if (selector === "#reader-container") return node === host;
    if (selector === ".reader-web") return node === engine.main;
    if (selector === ".reader-chapter-content.w-e-text") return node === engine.reader;
    return selector === node.tagName.toLowerCase();
  };
  for (const node of nodes) {
    node.ownerDocument = doc;
    const originalClosest = node.closest.bind(node), originalMatches = node.matches.bind(node);
    node.matches = selector => selector.split(",").some(part => simple(node, part)) || originalMatches(selector);
    node.closest = selector => {
      for (let parent = node; parent; parent = parent.parentElement) if (selector.split(",").some(part => simple(parent, part))) return parent;
      return originalClosest(selector);
    };
    node.queries.set("*", descendants(node));
  }
  engine.mappings.set("*", [...new Set([...engine.nodes, host, code])]);
  return { engine, root, host, code };
}

test("textbook diagnostics identify the native reading host instead of a 36px code example", async () => {
  const { engine } = textbookWithCode();
  const result = await engine.ask("ENGINE_PROBE");
  assert.equal(result.candidate.type, "text");
  assert.equal(result.diagnostics.scroll.target.viewportHeight, 664);
  assert.equal(result.diagnostics.scroll.target.contentHeight, 19009);
  assert.equal(result.diagnostics.scroll.target.position, 40);
});

test("restarting a textbook preserves code examples and the outer page, even when the example uses a custom scrollbar", async () => {
  for (const className of ["", "ps", "el-scrollbar__wrap"]) {
    const { engine, root, host, code } = textbookWithCode(className);
    const result = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
    assert.equal(result.ok, true);
    assert.equal(host.scrollTop, 0, "restart resets the real textbook host");
    assert.equal(code.scrollTop, 100, `a ${className || "native"} code block keeps its own position`);
    assert.equal(root.scrollTop, 116, "restart cannot reset the outer page");
    await engine.clock.advance(4000);
    assert.ok(host.scrollTop > 0, "read using the verified textbook host");
    assert.equal(code.scrollTop, 100, "a local example is not the whole lesson's reading component");
    assert.equal(root.scrollTop, 116, "reading cannot move the outer page");
  }
});
