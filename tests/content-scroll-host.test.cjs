"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

test("a code block's native scrollbar cannot replace its containing lesson's native reading host", async () => {
  const engine = createContent();
  const host = engine.main;
  host.style.overflowY = "auto";
  Object.assign(host, { clientHeight: 600, scrollHeight: 5000 });
  engine.reader.style.overflowY = "visible";
  engine.reader.clientHeight = engine.reader.scrollHeight = 5000;
  const code = element("pre", "示例代码".repeat(500));
  code.style.overflowY = "auto";
  Object.assign(code, { offsetTop: 300, clientHeight: 150, scrollHeight: 1800, parentElement: engine.reader, ownerDocument: engine.context.document });
  engine.reader.children = [code];
  engine.reader.queries.set("*", [code]);
  engine.mappings.set("*", [...engine.nodes, code]);
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
  await engine.clock.advance(1300);
  assert.ok(host.scrollTop > 0, "read the lesson using its nearest native ancestor host");
  assert.equal(code.scrollTop, 0, "a scrollable example is content, not the lesson scrolling component");
  assert.equal(code.scrolls.length, 0);
  assert.equal(engine.context.document.scrollingElement.scrollTop, 0);
});

test("a narrow introductory section expands to its common lesson host so sibling video and trailing text stay in the same task", async () => {
  const engine = createContent({ mediaTop: 900 });
  engine.main.style.overflowY = "auto";
  Object.assign(engine.main, { clientHeight: 600, scrollHeight: 2400 });
  const intro = element("section", "前置正文".repeat(80)); intro.className = "lesson-content";
  engine.reader.style.overflowY = "visible";
  engine.reader.clientHeight = engine.reader.scrollHeight = 700;
  intro.children = [engine.reader]; intro.parentElement = engine.main; engine.reader.parentElement = intro;
  const tail = element("article", "视频后的尾部正文".repeat(100));
  Object.assign(tail, { offsetTop: 1500, clientHeight: 800, scrollHeight: 800, parentElement: engine.main, ownerDocument: engine.context.document });
  engine.media.parentElement = engine.main;
  engine.main.children = [engine.heading, intro, engine.media, tail];
  const originalClosest = engine.reader.closest.bind(engine.reader);
  engine.reader.closest = selector => selector.includes(".lesson-content") ? intro : originalClosest(selector);
  engine.mappings.set(".lesson-content", [intro]);
  engine.mappings.set(".reader-content", [engine.reader]);
  engine.mappings.set("article", [engine.reader, tail]);
  engine.mappings.set("video", [engine.media]);
  engine.mappings.set("*", [...engine.nodes, intro, tail]);
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
  for (let step = 0; step < 30 && !engine.media.playCalls; step++) await engine.clock.advance(1000);
  assert.equal(engine.media.playCalls, 1, "a text-only section cannot hide the following video from the page runner");
  const playbackPosition = engine.main.scrollTop;
  engine.media.finish();
  for (let step = 0; step < 40 && engine.snapshot()?.phase !== "waiting_completion"; step++) await engine.clock.advance(1000);
  assert.equal(engine.snapshot().phase, "waiting_completion");
  assert.ok(engine.main.scrollTop > playbackPosition, "the same task reads the following sibling text");
  assert.equal(engine.main.scrollTop, 1800);
  assert.equal(engine.snapshot().flow.videosCompleted, 1);
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_DONE"), false);
});

test("a few pixels of hidden text overflow cannot steal a genuine native lesson host", async () => {
  const engine = createContent();
  engine.main.style.overflowY = "auto";
  Object.assign(engine.main, { clientHeight: 600, scrollHeight: 2400 });
  engine.reader.style.overflowY = "hidden";
  Object.assign(engine.reader, { clientHeight: 430, scrollHeight: 433 });
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
  await engine.clock.advance(5000);
  assert.ok(engine.main.scrollTop > 0);
  assert.equal(engine.reader.scrollTop, 0);
  assert.equal(engine.snapshot().phase, "reading");
});

test("a substantial hidden reader and a recognized PerfectScrollbar host remain controllable", async () => {
  for (const perfectScrollbar of [false, true]) {
    const engine = createContent();
    engine.reader.style.overflowY = "hidden";
    engine.reader.className = perfectScrollbar ? "ps" : "";
    engine.reader.scrollHeight = perfectScrollbar ? 433 : 1300;
    await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, resetPosition: true });
    await engine.clock.advance(1300);
    assert.ok(engine.reader.scrollTop > 0, "an actual hidden scroll host retains normal scrolling support");
    assert.equal(engine.context.document.scrollingElement.scrollTop, 0);
  }
});
