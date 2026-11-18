"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const doneCount = engine => engine.outbound.filter(message => message.type === "ENGINE_DONE").length;

function panelLesson({ type = "text", height = 400, contentHeight = 1800, top = 200 } = {}) {
  const engine = createContent({ type });
  const outer = engine.context.document.scrollingElement;
  Object.assign(outer, { scrollHeight: 6000, scrollTop: 180 });
  Object.assign(engine.main, { offsetTop: top + outer.scrollTop, clientHeight: height, scrollHeight: contentHeight });
  engine.main.style.overflowY = "auto";
  engine.reader.style.overflowY = "visible";
  engine.reader.clientHeight = engine.reader.scrollHeight = contentHeight;
  return { engine, panel: engine.main, outer };
}

async function advanceUntil(engine, condition, maxSeconds = 80) {
  for (let elapsed = 0; elapsed < maxSeconds && !condition(); elapsed++) await engine.clock.advance(1000);
  assert.ok(condition(), "the panel runner did not reach the expected state");
}

test("fresh learning resets only the independent course panel and never falls back to the outer page at its bottom", async () => {
  const { engine, panel, outer } = panelLesson();
  panel.scrollTop = 240;
  const started = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(started.ok, true);
  assert.equal(panel.scrollTop, 0, "fresh learning starts at the course panel top");
  assert.equal(outer.scrollTop, 180, "fresh learning preserves the surrounding page position");
  await advanceUntil(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(panel.scrollTop, panel.scrollHeight - panel.clientHeight);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0, "the outer page is not a fallback after reaching the panel bottom");
  assert.equal(doneCount(engine), 0, "the panel bottom is not proof of platform completion");
  const panelCallsAtBottom = panel.scrolls.length;
  await engine.clock.advance(15000);
  assert.equal(panel.scrolls.length, panelCallsAtBottom);
  assert.equal(outer.scrollTop, 180);
});

test("a short overflow-auto course panel keeps its boundary even when it has no scroll range", async () => {
  const { engine, panel, outer } = panelLesson({ contentHeight: 400 });
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(15000);
  assert.equal(panel.scrollTop, 0);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0, "a short panel cannot cause the surrounding page to scroll instead");
  assert.equal(engine.snapshot().phase, "waiting_completion");
  assert.equal(doneCount(engine), 0);
});

test("a player centered in a panel near the bottom of the window plays without moving either page", async () => {
  const { engine, panel, outer } = panelLesson({ type: "video", height: 250, contentHeight: 250, top: 650 });
  Object.assign(engine.media, { offsetTop: 25, clientHeight: 200, scrollHeight: 200 });
  const rect = engine.media.getBoundingClientRect();
  assert.equal(rect.top + rect.height / 2, 775, "the player is centered in the panel rather than in the 900px window");
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(1100);
  assert.equal(engine.media.playCalls, 1);
  assert.equal(engine.snapshot().phase, "playing");
  assert.equal(panel.scrollTop, 0);
  assert.equal(panel.scrolls.length, 0);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
});

test("panel text, video and trailing text preserve position on continue and restart only inside the panel", async () => {
  const { engine, panel, outer } = panelLesson({ contentHeight: 2200 });
  const tail = element("article", "视频之后仍须逐步阅读的课程尾部正文".repeat(70));
  Object.assign(engine.reader, { clientHeight: 600, scrollHeight: 600 });
  Object.assign(engine.media, { offsetTop: 650, clientHeight: 200, scrollHeight: 200, parentElement: panel });
  Object.assign(tail, { offsetTop: 900, clientHeight: 1100, scrollHeight: 1100, parentElement: panel, ownerDocument: engine.context.document });
  panel.children = [engine.heading, engine.reader, engine.media, tail];
  panel.innerText = panel.textContent = engine.reader.textContent + tail.textContent;
  engine.mappings.set(".reader-content", [engine.reader, tail]);
  engine.mappings.set("article", [engine.reader, tail]);
  engine.mappings.set("video", [engine.media]);
  engine.mappings.set("*", [...engine.nodes, tail]);
  panel.scrollTop = 300;
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true, runId: "panel-first-run" });
  assert.equal(panel.scrollTop, 0);
  assert.equal(outer.scrollTop, 180);
  await engine.clock.advance(1500);
  assert.ok(panel.scrollTop > 0 && panel.scrollTop <= 240);
  assert.equal(engine.media.playCalls, 0, "the initial text is traversed before playback");
  const paused = await engine.ask("ENGINE_PAUSE");
  const positionAtPause = panel.scrollTop;
  await engine.clock.advance(10000);
  assert.equal(panel.scrollTop, positionAtPause);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: false, checkpoint: paused.snapshot, runId: "panel-continued-run" });
  assert.equal(panel.scrollTop, positionAtPause, "continue retains the panel position");
  await advanceUntil(engine, () => engine.media.playCalls > 0);
  const rect = engine.media.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  assert.ok(Math.abs(rect.top + rect.height / 2 - (panelRect.top + panelRect.height / 2)) <= 40);
  const playbackPosition = panel.scrollTop;
  await engine.clock.advance(5000);
  assert.equal(panel.scrollTop, playbackPosition, "panel reading pauses while the video plays");
  engine.media.finish();
  await advanceUntil(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.ok(panel.scrollTop > playbackPosition, "video end resumes the same panel's trailing text");
  assert.equal(panel.scrollTop, panel.scrollHeight - panel.clientHeight);
  assert.equal(engine.snapshot().flow.videosCompleted, 1);
  assert.equal(doneCount(engine), 0);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true, runId: "panel-restarted-run" });
  assert.equal(panel.scrollTop, 0, "restart returns the course panel to its own top");
  assert.equal(engine.media.currentTime, 0);
  assert.equal(engine.snapshot().flow.playedMediaIds.length, 0);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
});

test("generic help text outside an identified reader cannot widen its independent panel boundary", async () => {
  const engine = createContent();
  const outer = engine.context.document.scrollingElement;
  Object.assign(outer, { scrollHeight: 6000, scrollTop: 180 });
  engine.main.offsetTop = 380;
  const panel = element("div");
  Object.assign(panel, { clientHeight: 300, scrollHeight: 450, scrollTop: 40, parentElement: engine.main, ownerDocument: engine.context.document });
  panel.style.overflowY = "auto";
  engine.reader.style.overflowY = "visible";
  Object.assign(engine.reader, { clientHeight: 450, scrollHeight: 450, parentElement: panel });
  panel.children = [engine.reader];
  const help = element("p", "课程面板外的页面帮助说明".repeat(20));
  Object.assign(help, { offsetTop: 500, parentElement: engine.main, ownerDocument: engine.context.document });
  engine.main.children = [engine.heading, panel, help];
  engine.main.queries.set("p,pre,blockquote,article,[role='document']", [engine.reader, help]);
  engine.mappings.set("*", [...engine.nodes, panel, help]);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(panel.scrollTop, 0);
  assert.equal(outer.scrollTop, 180, "outside help paragraphs cannot pull restart out of the recognized panel");
  await advanceUntil(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(panel.scrollTop, 150);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
  assert.equal(doneCount(engine), 0);
});

test("an overflow-hidden application shell never becomes the fallback after its inner course panel ends", async () => {
  const engine = createContent();
  const outer = engine.context.document.scrollingElement;
  Object.assign(outer, { scrollHeight: 6000, scrollTop: 180 });
  Object.assign(engine.main, { offsetTop: 380, clientHeight: 500, scrollHeight: 800, scrollTop: 60 });
  engine.main.style.overflowY = "hidden";
  const panel = element("div");
  Object.assign(panel, { clientHeight: 300, scrollHeight: 450, scrollTop: 40, parentElement: engine.main, ownerDocument: engine.context.document });
  panel.style.overflowY = "auto";
  engine.reader.style.overflowY = "visible";
  Object.assign(engine.reader, { clientHeight: 450, scrollHeight: 450, parentElement: panel });
  panel.children = [engine.reader];
  engine.main.children = [engine.heading, panel];
  engine.mappings.set("*", [...engine.nodes, panel]);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(panel.scrollTop, 0);
  assert.equal(engine.main.scrollTop, 60, "fresh learning does not reset the surrounding application shell");
  await advanceUntil(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(panel.scrollTop, 150);
  const shellCallsAtBottom = engine.main.scrolls.length;
  await engine.clock.advance(15000);
  assert.equal(engine.main.scrollTop, 60);
  assert.equal(engine.main.scrolls.length, shellCallsAtBottom);
  assert.equal(engine.main.scrolls.length, 0, "the application shell never receives course scrolling commands");
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
  assert.equal(doneCount(engine), 0);
});

test("a non-scrollable hidden player wrapper cannot capture the independent course scroll boundary", async () => {
  const { engine, panel, outer } = panelLesson({ type: "video", contentHeight: 1800 });
  const wrapper = element("div");
  Object.assign(wrapper, { offsetTop: 900, clientHeight: 200, scrollHeight: 200, parentElement: panel, ownerDocument: engine.context.document });
  wrapper.style.overflowY = "hidden";
  Object.assign(engine.media, { offsetTop: 0, clientHeight: 200, scrollHeight: 200, parentElement: wrapper });
  wrapper.children = [engine.media];
  panel.children = [engine.heading, wrapper];
  engine.mappings.set("*", [...engine.nodes, wrapper]);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(panel.scrollTop, 0);
  assert.equal(engine.media.playCalls, 0, "an offscreen wrapper is not a centered player");
  await advanceUntil(engine, () => engine.media.playCalls > 0);
  assert.ok(panel.scrollTop > 0, "the course panel moves the player toward its own center");
  const mediaRect = engine.media.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  assert.ok(Math.abs(mediaRect.top + mediaRect.height / 2 - (panelRect.top + panelRect.height / 2)) <= 40);
  assert.equal(wrapper.scrollTop, 0);
  assert.equal(wrapper.scrolls.length, 0, "a clipping wrapper without a range receives no course scrolling");
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
  assert.equal(doneCount(engine), 0);
});

test("a fully visible player wrapper below the panel center does not authorize early playback", async () => {
  const { engine, panel, outer } = panelLesson({ height: 600, contentHeight: 1800, top: 100 });
  Object.assign(engine.reader, { clientHeight: 300, scrollHeight: 300 });
  const wrapper = element("div");
  Object.assign(wrapper, { offsetTop: 350, clientHeight: 200, scrollHeight: 200, parentElement: panel, ownerDocument: engine.context.document });
  wrapper.style.overflowY = "hidden";
  Object.assign(engine.media, { offsetTop: 0, clientHeight: 200, scrollHeight: 200, parentElement: wrapper });
  wrapper.children = [engine.media];
  const tail = element("article", "播放器之后的课程尾部文字".repeat(80));
  Object.assign(tail, { offsetTop: 600, clientHeight: 1200, scrollHeight: 1200, parentElement: panel, ownerDocument: engine.context.document });
  panel.children = [engine.heading, engine.reader, wrapper, tail];
  engine.mappings.set(".reader-content", [engine.reader, tail]);
  engine.mappings.set("article", [engine.reader, tail]);
  engine.mappings.set("video", [engine.media]);
  engine.mappings.set("*", [...engine.nodes, wrapper, tail]);
  const initial = engine.media.getBoundingClientRect();
  assert.equal(initial.top + initial.height / 2, 550);
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(899);
  assert.equal(engine.media.playCalls, 0, "a player matching its own clip wrapper center must still wait for the course panel center");
  assert.equal(panel.scrollTop, 0);
  await advanceUntil(engine, () => engine.media.playCalls > 0);
  const mediaRect = engine.media.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  assert.ok(Math.abs(mediaRect.top + mediaRect.height / 2 - (panelRect.top + panelRect.height / 2)) <= 60);
  assert.ok(panel.scrollTop > 0);
  engine.media.finish();
  await advanceUntil(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(panel.scrollTop, 1200, "after playback the panel still reads its trailing text");
  assert.equal(wrapper.scrollTop, 0);
  assert.equal(wrapper.scrolls.length, 0);
  assert.equal(outer.scrollTop, 180);
  assert.equal(outer.scrolls.length, 0);
  assert.equal(doneCount(engine), 0);
});
