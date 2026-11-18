"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const append = (parent, children) => { parent.children = children; children.forEach(child => { child.parentElement = parent; }); };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

// The screenshot's sidebar is a normal DIV component, not a semantic nav/aside.
// Its paragraph labels and large icons deliberately satisfy the former broad
// embedded-document fallback, and it appears before the real reader in DOM order.
function fixture({ textbook = true, catalogClass = "reader-catalog", overflow = "auto", customBody = false, wrappedCatalog = false } = {}) {
  const engine = createContent();
  const doc = engine.context.document, root = doc.scrollingElement;
  Object.assign(root, { clientHeight: 935, scrollHeight: 1384, scrollTop: 149 });
  engine.context.innerHeight = 935;
  const shell = element("div"); shell.className = textbook ? "reader-web" : "course-layout";
  Object.assign(shell, { offsetTop: 185, clientWidth: 1400, clientHeight: 720, scrollHeight: 720 });
  const catalog = element("div", "目录章节条目。".repeat(100));
  catalog.className = catalogClass;
  Object.assign(catalog, { clientWidth: 420, clientHeight: 664, scrollHeight: 664 });
  const catalogScroll = element("div", "目录与已完成状态。".repeat(100));
  catalogScroll.className = "el-scrollbar__wrap";
  catalogScroll.style.overflowY = overflow;
  Object.assign(catalogScroll, { clientWidth: 420, clientHeight: 664, scrollHeight: 4200, scrollTop: 137 });
  const icon = element("img", "", { src: "https://example.test/chapter-cover.png" });
  Object.assign(icon, { clientWidth: 100, clientHeight: 100 });
  const catalogText = element("p", "第1章 操作系统简介，第2章开发环境，第3章操作系统基础。".repeat(20));
  const labels = Array.from({ length: 12 }, (_, index) => element("button", `第 ${index + 1} 章 课程目录`));
  append(catalogScroll, [icon, catalogText, ...labels]); append(catalog, [catalogScroll]);
  const right = element("div"); right.className = textbook ? "reader-right" : "lesson-content";
  Object.assign(right, { offsetLeft: 450, clientWidth: 900, clientHeight: 664, scrollHeight: 664 });
  const host = element("div", "", textbook ? { id: "reader-container" } : { id: "body-scroll" });
  host.className = textbook ? "reader-container" : "reader-content";
  host.style.overflowY = "auto";
  Object.assign(host, { clientWidth: 900, clientHeight: 664, scrollHeight: 2600, scrollTop: 310 });
  const chapter = element("div", "正文内容必须逐段向下阅读，目录不属于正文。".repeat(150));
  chapter.className = textbook ? "reader-chapter-content w-e-text" : "article-content";
  Object.assign(chapter, { clientWidth: 900, clientHeight: 2530, scrollHeight: 2530 });
  const paragraph = element("p", "这里是实际教材正文，滚动只能发生在右侧阅读器内。".repeat(100));
  Object.assign(paragraph, { clientWidth: 900, clientHeight: 2500, scrollHeight: 2500 });
  append(chapter, [paragraph]); append(host, [chapter]); append(right, [host]); append(shell, [catalog, right]); append(root, [shell]);
  let catalogPort = catalogScroll;
  if (customBody) {
    host.className = "office-page-scroll";
    host.innerText = host.textContent = chapter.innerText;
    chapter.className = "office-page";
  }
  if (wrappedCatalog) {
    catalog.className = "el-tree";
    catalogScroll.className = "directory-contents";
    catalogScroll.style.overflowY = "visible";
    catalogPort = element("div", "目录中全部章节的标签和状态。".repeat(100));
    catalogPort.className = "directory-scroll-shell";
    catalogPort.style.overflowY = overflow;
    Object.assign(catalogPort, { clientWidth: 420, clientHeight: 664, scrollHeight: 4200, scrollTop: 137 });
    // The scrollbar belongs to an unmarked ancestor, but every piece of its
    // purported document evidence belongs to the excluded directory tree.
    Object.assign(icon, { clientWidth: 300, clientHeight: 200 });
    append(catalogPort, [catalog]); append(shell, [catalogPort, right]);
  }

  const compound = (node, selector) => {
    if (!selector) return false;
    const attributes = [...selector.matchAll(/\[([\w-]+)(?:([*^$]?=)['"]?([^'"\]]*)['"]?)?\]/g)];
    const plain = selector.replace(/\[[^\]]+\]/g, "");
    if (plain && !/^(?:[a-z][\w-]*)?(?:[.#][\w-]+)*$/i.test(plain)) return false;
    const tag = plain.match(/^[a-z][\w-]*/i)?.[0], id = plain.match(/#([\w-]+)/)?.[1];
    if (tag && node.tagName.toLowerCase() !== tag.toLowerCase() || id && node.getAttribute("id") !== id) return false;
    if (![...plain.matchAll(/\.([\w-]+)/g)].every(match => node.className.split(/\s+/).includes(match[1]))) return false;
    return attributes.every(([, name, operator, value]) => {
      const actual = node.getAttribute(name);
      if (!operator) return actual !== null;
      if (operator === "=") return actual === value;
      if (operator === "*=") return actual?.includes(value);
      if (operator === "^=") return actual?.startsWith(value);
      if (operator === "$=") return actual?.endsWith(value);
      return false;
    });
  };
  const matches = (node, selector) => selector.split(",").some(raw => {
    const parts = raw.trim().split(/\s+(?![^\[]*\])/);
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
    node.ownerDocument = doc;
    node.matches = selector => matches(node, selector);
    node.closest = selector => { for (let parent = node; parent; parent = parent.parentElement) if (matches(parent, selector)) return parent; return null; };
    node.querySelectorAll = selector => descendants(node).filter(child => selector === "*" || matches(child, selector));
  }
  doc.querySelectorAll = selector => [root, ...descendants(root)].filter(node => selector === "*" || matches(node, selector));
  doc.title = "【数字教材】openEuler 操作系统教程";
  const parent = {};
  engine.context.parent = engine.context.top = parent;
  const token = "bound-course-catalog-reproduction";
  engine.emitWindow("message", { source: parent, data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token } });
  // Ancestor geometry projection has separate coverage. Keep this test focused
  // on selecting the right local component after a genuine parent bind event.
  engine.context.parent = engine.context.top = engine.context;
  const run = () => engine.ask("ENGINE_EMBEDDED_RUN", { token, runId: "catalog-exclusion", resetPosition: true, settings });
  return { engine, root, shell, catalog, catalogScroll, catalogPort, right, host, chapter, run };
}

test("a bound textbook probes its actual reading container rather than a preceding DIV catalog", async () => {
  const { engine, host, catalogScroll } = fixture();
  const probe = await engine.ask("ENGINE_PROBE", { settings });
  assert.equal(probe.diagnostics.scroll.target.contentHeight, host.scrollHeight, "the diagnostic must describe the right reader, not the taller catalog");
  assert.equal(probe.diagnostics.scroll.target.position, 310);
  assert.equal(catalogScroll.scrollTop, 137);
});

test("start and restart scroll only the bound textbook body while its DIV catalog stays untouched", async () => {
  const { engine, root, host, catalogScroll, run } = fixture();
  assert.equal((await run()).ok, true);
  assert.equal(catalogScroll.scrollTop, 137, "start must not reset the catalog");
  assert.equal(catalogScroll.scrolls.length, 0, "the extension must never issue a catalog scroll");
  assert.equal(host.scrollTop, 0, "start resets the actual body");
  await engine.clock.advance(4000);
  assert.ok(host.scrollTop > 0, "timed reading must move the body");
  assert.equal(catalogScroll.scrollTop, 137);
  assert.equal(root.scrollTop, 149);
  await engine.ask("ENGINE_STOP");
  assert.equal((await run()).ok, true);
  assert.equal(host.scrollTop, 0);
  assert.equal(catalogScroll.scrolls.length, 0, "restart must not touch the catalog either");
  await engine.clock.advance(30000);
  assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight);
  assert.equal(catalogScroll.scrollTop, 137, "body completion cannot transfer reading to the directory");
  assert.equal(catalogScroll.scrolls.length, 0);
  assert.equal(root.scrollTop, 149);
});

test("a normal reader wins over an earlier catalog with its own native or hidden scrollbar", async () => {
  for (const overflow of ["auto", "hidden"]) {
    const { engine, root, host, catalogScroll, run } = fixture({ textbook: false, catalogClass: "catalog-tree", overflow });
    assert.equal((await run()).ok, true);
    assert.equal(catalogScroll.scrollTop, 137, `${overflow} catalog must keep its initial position`);
    assert.equal(host.scrollTop, 0);
    await engine.clock.advance(4000);
    assert.ok(host.scrollTop > 0);
    await engine.clock.advance(30000);
    assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight);
    assert.equal(catalogScroll.scrollTop, 137);
    assert.equal(catalogScroll.scrolls.length, 0);
    assert.equal(root.scrollTop, 149);
  }
});

test("directory descendants cannot qualify their unmarked scroll ancestor as a custom Word document", async () => {
  for (const overflow of ["auto", "hidden"]) {
    const { engine, root, catalogPort, host, run } = fixture({ textbook: false, customBody: true, wrappedCatalog: true, overflow });
    const probe = await engine.ask("ENGINE_PROBE", { settings });
    assert.equal(probe.diagnostics.scroll.target.contentHeight, host.scrollHeight, "directory-only text and image evidence must not qualify the earlier left scrollbar");
    assert.equal(probe.diagnostics.scroll.target.position, 310);
    assert.equal((await run()).ok, true);
    assert.equal(host.scrollTop, 0);
    assert.equal(catalogPort.scrollTop, 137);
    assert.equal(catalogPort.scrolls.length, 0, "start cannot reset an unmarked directory ancestor");
    await engine.clock.advance(4000);
    assert.ok(host.scrollTop > 0);
    assert.equal(catalogPort.scrollTop, 137);
    await engine.clock.advance(30000);
    assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight);
    assert.equal(catalogPort.scrolls.length, 0, "body completion cannot transfer reading to the left directory ancestor");
    assert.equal(root.scrollTop, 149);
  }
});
