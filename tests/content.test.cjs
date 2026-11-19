"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { createContent, element, mediaElement } = require("./helpers/content-harness.cjs");
const doneCount = (engine) => engine.outbound.filter((message) => message.type === "ENGINE_DONE").length;

function sequenceLesson() {
  const engine = createContent({ mediaTop: 900 });
  const middle = element("article", "两段视频之间的学习正文".repeat(60));
  const tail = element("article", "第二段视频之后的尾部学习正文".repeat(60));
  const second = mediaElement({ src: "https://e.huawei.com/media/second.mp4" });
  engine.reader.style.overflowY = "visible";
  engine.reader.clientHeight = engine.reader.scrollHeight = 800;
  Object.assign(middle, { offsetTop: 1400, clientHeight: 600, scrollHeight: 600 });
  Object.assign(second, { offsetTop: 2100 });
  Object.assign(tail, { offsetTop: 2600, clientHeight: 800, scrollHeight: 800 });
  engine.main.children = [engine.heading, engine.reader, engine.media, middle, second, tail];
  engine.main.innerText = engine.main.textContent = engine.reader.textContent + middle.textContent + tail.textContent;
  engine.main.children.forEach(node => { node.parentElement = engine.main; node.ownerDocument = engine.context.document; });
  for (const selector of [".reader-content", "article"]) engine.mappings.set(selector, [engine.reader, middle, tail]);
  engine.mappings.set("video", [engine.media, second]);
  engine.mappings.set("*", [...engine.nodes, middle, second, tail]);
  const root = engine.context.document.scrollingElement;
  root.scrollHeight = 3500;
  return { engine, root, first: engine.media, second, middle, tail, settings: { scrollIntervalSeconds: 1, scrollEnabled: true } };
}

async function advanceUntil(engine, condition, maxSeconds = 90) {
  for (let elapsed = 0; elapsed < maxSeconds && !condition(); elapsed++) await engine.clock.advance(1000);
  assert.ok(condition(), "the expected page-learning state was not reached");
}

test("reading never completes from elapsed time or an obsolete reading checkpoint", async () => {
  for (const type of ["text", "document"]) {
    const engine = createContent({ type });
    const started = await engine.ask("ENGINE_RUN", { settings: { readSeconds: 5, scrollEnabled: false } });
    assert.equal(started.ok, true);
    await engine.clock.advance(120_000);
    const paused = await engine.ask("ENGINE_PAUSE");
    await engine.clock.advance(60_000);
    await engine.ask("ENGINE_RUN", { settings: { scrollEnabled: false }, checkpoint: { ...paused.snapshot, remainingSeconds: 0 } });
    await engine.clock.advance(120_000);
    assert.equal(doneCount(engine), 0, `${type} must wait for an explicit task change rather than a reading timer`);
    assert.ok(["reading", "waiting_completion"].includes(engine.snapshot().phase));
  }
});

test("each scroll waits within the configured interval and its small random variation", async () => {
  for (const random of [0, 1]) {
    const engine = createContent();
    engine.context.Math.random = () => random;
    const started = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 10, scrollEnabled: true } });
    assert.equal(started.ok, true);
    await engine.clock.advance(8999);
    assert.equal(engine.reader.scrolls.length, 0, "first movement must also honor the interval");
    await engine.clock.advance(random ? 2001 : 1);
    assert.equal(engine.reader.scrolls.length, 1);
    await engine.clock.advance(350);
    const first = engine.reader.scrollTop;
    await engine.clock.advance(12_000);
    assert.ok(engine.reader.scrollTop > first, "the next interval must move downward again");
    assert.equal(doneCount(engine), 0);
  }
});

test("random reading scroll targets the actual nested reader and stops immediately on pause", async () => {
  const engine = createContent();
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
  await engine.clock.advance(1500);
  assert.equal(engine.reader.scrolls.length, 1);
  assert.ok(engine.reader.scrollTop > 0);
  await engine.ask("ENGINE_PAUSE");
  const positionAtPause = engine.reader.scrollTop;
  const callsAtPause = engine.reader.scrolls.length;
  await engine.clock.advance(20_000);
  assert.equal(engine.reader.scrollTop, positionAtPause);
  assert.equal(engine.reader.scrolls.length, callsAtPause);
});

test("text and document tasks scroll only downward and wait at the bottom without completing", async () => {
  for (const type of ["text", "document"]) {
    const engine = createContent({ type, title: `短课时 · ${type}` });
    await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
    await engine.clock.advance(45_000);
    assert.equal(engine.reader.scrollTop, engine.reader.scrollHeight - engine.reader.clientHeight);
    let previous = 0;
    for (const movement of engine.reader.scrolls) { assert.ok(movement.top >= previous); previous = movement.top; }
    assert.equal(doneCount(engine), 0);
    assert.ok(["bottom", "waiting_completion"].includes(engine.snapshot().scroll.state));
    const scrollsAtBottom = engine.reader.scrolls.length;
    await engine.clock.advance(20_000);
    assert.equal(engine.reader.scrolls.length, scrollsAtBottom, "waiting at the bottom must not repeatedly scroll up or emit completion");
    assert.equal(doneCount(engine), 0);
  }
});

test("a deeply nested reader scrolls its actual ancestor beyond the old five-level search limit", async () => {
  const engine = createContent();
  engine.reader.style.overflowY = "visible";
  engine.reader.scrollHeight = engine.reader.clientHeight;
  let outer = engine.reader;
  for (let depth = 0; depth < 7; depth++) {
    const wrapper = element("div");
    wrapper.children = [outer];
    outer.parentElement = wrapper;
    outer = wrapper;
  }
  outer.style.overflowY = "auto";
  outer.scrollHeight = 3000;
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
  await engine.clock.advance(4000);
  assert.ok(outer.scrollTop > 0, "the outer course reader owns scrolling even when several layout wrappers intervene");
  assert.equal(engine.context.document.scrollingElement.scrolls.length, 0, "an unscrollable document root is not a substitute for the actual reader");
});

test("a scrollable reader takes priority over a larger surrounding page shell", async () => {
  const engine = createContent();
  engine.main.style.overflowY = "auto";
  engine.main.clientWidth = 1200;
  engine.main.clientHeight = 800;
  engine.main.scrollHeight = 6000;
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
  await engine.clock.advance(4000);
  assert.ok(engine.reader.scrollTop > 0, "move within the lesson rather than scrolling the surrounding application chrome");
  assert.equal(engine.main.scrolls.length, 0);
});

test("a broad lesson wrapper never selects its scrollable course-navigation sidebar", async () => {
  const engine = createContent();
  engine.reader.style.overflowY = "visible";
  engine.reader.scrollHeight = engine.reader.clientHeight;
  const sidebar = element("nav", "课程目录".repeat(80));
  sidebar.style.overflowY = "auto";
  sidebar.clientWidth = 900;
  sidebar.clientHeight = 600;
  sidebar.scrollHeight = 6000;
  const body = element("div", "本节正文".repeat(150));
  body.style.overflowY = "auto";
  body.clientWidth = 640;
  body.clientHeight = 430;
  body.scrollHeight = 5000;
  sidebar.parentElement = engine.reader;
  body.parentElement = engine.reader;
  engine.reader.children = [sidebar, body];
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
  await engine.clock.advance(4000);
  assert.ok(body.scrollTop > 0, "the readable body should move even if the directory has a larger viewport");
  assert.equal(sidebar.scrolls.length, 0, "automatic reading must not scroll the course directory");
});

test("mixed text and video content is read in small steps before the naturally centered video takes over", async () => {
  const engine = createContent({ mediaTop: 1800 });
  engine.reader.style.overflowY = "visible";
  engine.reader.clientHeight = engine.reader.scrollHeight = 1400;
  engine.main.children = [engine.heading, engine.reader, engine.media];
  engine.media.parentElement = engine.main;
  engine.mappings.set("video", [engine.media]);
  const root = engine.context.document.scrollingElement;
  root.scrollHeight = 5000;
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
  const detected = await engine.ask("ENGINE_PROBE", { settings });
  assert.equal(detected.candidate.type, "text", "a lower video must not bypass the preceding lesson text");
  assert.equal(detected.candidate.readingBeforeVideo, true);
  await engine.ask("ENGINE_RUN", { settings });
  await engine.clock.advance(899);
  assert.equal(root.scrollTop, 0);
  assert.equal(engine.media.playCalls, 0);
  await engine.clock.advance(351);
  assert.ok(root.scrollTop > 0 && root.scrollTop <= 240, "the first interval makes one small reading step");
  assert.equal(engine.media.playCalls, 0);
  await advanceUntil(engine, () => engine.media.playCalls === 1);
  assert.equal(engine.media.playCalls, 1, "post-scroll detection eventually hands control to the video");
  let previous = 0;
  for (const movement of root.scrolls) {
    assert.ok(movement.top >= previous && movement.top - previous <= 240, "mixed content never makes a large jump to bypass text");
    previous = movement.top;
  }
  const rect = engine.media.getBoundingClientRect();
  assert.ok(Math.abs(rect.top + rect.height / 2 - 450) <= 80);
  const atPlayback = root.scrollTop;
  const scrollsAtPlayback = root.scrolls.length;
  await engine.clock.advance(15_000);
  assert.equal(root.scrollTop, atPlayback);
  assert.equal(root.scrolls.length, scrollsAtPlayback);
  assert.equal(doneCount(engine), 0);
});

test("fresh page learning returns to the top and processes two videos, intervening text and trailing text before platform completion", async () => {
  const { engine, root, first, second, settings } = sequenceLesson();
  root.scrollTop = 1800;
  const started = await engine.ask("ENGINE_RUN", { settings, resetPosition: true, runId: "page-sequence" });
  assert.equal(started.ok, true);
  assert.equal(started.candidate.flowRoot, true);
  assert.equal(root.scrollTop, 0, "a fresh start learns the current task from its top");
  const taskKey = started.candidate.key;
  await advanceUntil(engine, () => first.playCalls === 1);
  assert.equal(second.playCalls, 0);
  const firstPosition = root.scrollTop;
  await engine.clock.advance(5000);
  assert.equal(root.scrollTop, firstPosition, "the page stops while the first video is playing");
  first.finish();
  await engine.clock.settle();
  assert.equal(doneCount(engine), 0, "a video ended event cannot complete the whole current task");
  assert.equal(engine.snapshot().key, taskKey, "reading and media share the same stable task identity");
  await advanceUntil(engine, () => second.playCalls === 1);
  assert.ok(root.scrollTop > firstPosition, "the intervening text is traversed before the second video");
  assert.equal(first.playCalls, 1);
  const secondPosition = root.scrollTop;
  second.finish();
  await engine.clock.settle();
  assert.equal(doneCount(engine), 0);
  await advanceUntil(engine, () => root.scrollTop === root.scrollHeight - root.clientHeight);
  assert.ok(root.scrollTop > secondPosition, "trailing text is still traversed after the last video");
  await engine.clock.advance(30_000);
  assert.equal(doneCount(engine), 0, "reaching the last text is not a platform completion signal");
  assert.equal(engine.snapshot().phase, "waiting_completion");
  assert.equal(first.playCalls, 1);
  assert.equal(second.playCalls, 1);
  engine.active.setAttribute("data-completed", "true");
  engine.mutate();
  await engine.clock.advance(3000);
  assert.equal(doneCount(engine), 1);
  assert.equal(engine.outbound.find(message => message.type === "ENGINE_DONE").completionReason, "platform");
  await engine.clock.advance(20_000);
  assert.equal(doneCount(engine), 1);
});

test("an early platform-complete signal never skips unplayed videos or the rest of the current page", async () => {
  const { engine, root, first, second, settings } = sequenceLesson();
  const signal = element("span", "平台确认完成");
  engine.mappings.set("#platformComplete", [signal]);
  settings.selectors = { completed: "#platformComplete" };
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(3000);
  assert.equal(doneCount(engine), 0);
  await advanceUntil(engine, () => first.playCalls === 1);
  first.finish();
  await advanceUntil(engine, () => second.playCalls === 1);
  assert.equal(doneCount(engine), 0);
  second.finish();
  await advanceUntil(engine, () => doneCount(engine) === 1);
  assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
});

test("pause and resume preserve page position and played media, while restart resets both", async () => {
  const { engine, root, first, second, settings } = sequenceLesson();
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await advanceUntil(engine, () => first.playCalls === 1);
  first.finish();
  await engine.clock.advance(2000);
  const paused = await engine.ask("ENGINE_PAUSE");
  const pausedPosition = root.scrollTop;
  assert.ok(paused.snapshot.flow.playedMediaIds.length > 0);
  await engine.clock.advance(30_000);
  assert.equal(root.scrollTop, pausedPosition);
  await engine.ask("ENGINE_RUN", { settings, checkpoint: paused.snapshot, resetPosition: false });
  assert.equal(root.scrollTop, pausedPosition);
  await advanceUntil(engine, () => second.playCalls === 1);
  assert.equal(first.playCalls, 1, "resume must not replay a video that ended before the pause");
  await engine.ask("ENGINE_STOP");
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(root.scrollTop, 0);
  assert.equal(first.currentTime, 0);
  assert.equal(second.currentTime, 0);
  assert.equal(engine.snapshot().flow.playedMediaIds.length, 0);
  await advanceUntil(engine, () => first.playCalls === 2);
  assert.equal(second.playCalls, 1);
  assert.equal(doneCount(engine), 0);
});

test("a manual task route change cannot inherit played media from the previous page", async () => {
  const { engine, root, first, settings } = sequenceLesson();
  const started = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await advanceUntil(engine, () => first.playCalls === 1);
  first.finish();
  await engine.clock.advance(1500);
  const checkpoint = (await engine.ask("ENGINE_PAUSE")).snapshot;
  engine.context.location.hash = "#new-manual-task";
  engine.active.setAttribute("data-task-id", "task-two");
  engine.emitWindow("hashchange");
  await engine.clock.advance(550);
  const fresh = await engine.ask("ENGINE_RUN", { settings, checkpoint, resetPosition: true });
  assert.notEqual(fresh.candidate.key, started.candidate.key);
  assert.equal(root.scrollTop, 0);
  assert.equal(fresh.snapshot.flow.playedMediaIds.length, 0);
  await advanceUntil(engine, () => first.playCalls === 2);
});

test("a mixed lesson with reading scroll disabled waits rather than jumping over its text", async () => {
  const engine = createContent({ mediaTop: 1800 });
  engine.reader.style.overflowY = "visible";
  engine.reader.clientHeight = engine.reader.scrollHeight = 1400;
  engine.main.children = [engine.heading, engine.reader, engine.media];
  engine.media.parentElement = engine.main;
  engine.mappings.set("video", [engine.media]);
  engine.context.document.scrollingElement.scrollHeight = 5000;
  await engine.ask("ENGINE_RUN", { settings: { scrollEnabled: false } });
  await engine.clock.advance(30_000);
  assert.equal(engine.context.document.scrollingElement.scrollTop, 0);
  assert.equal(engine.media.playCalls, 0);
  assert.equal(doneCount(engine), 0);
});

test("a separate inner text reader is read to its bottom before the outer page advances toward video", async () => {
  const engine = createContent({ mediaTop: 1800 });
  engine.reader.scrollHeight = 700;
  engine.main.children = [engine.heading, engine.reader, engine.media];
  engine.media.parentElement = engine.main;
  engine.mappings.set("video", [engine.media]);
  const root = engine.context.document.scrollingElement;
  root.scrollHeight = 5000;
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
  await engine.ask("ENGINE_RUN", { settings });
  await engine.clock.advance(1250);
  assert.ok(engine.reader.scrollTop > 0);
  assert.equal(root.scrollTop, 0, "the inner reading region has priority over moving the page past it");
  await engine.clock.advance(6000);
  assert.equal(engine.reader.scrollTop, engine.reader.scrollHeight - engine.reader.clientHeight);
  assert.ok(root.scrollTop > 0, "after the reader bottom, later intervals can advance the containing page");
  assert.equal(engine.media.playCalls, 0);
  assert.equal(doneCount(engine), 0);
});

test("a naturally centered video still waits until its preceding independent reader reaches the bottom", async () => {
  const engine = createContent({ mediaTop: 235 });
  engine.reader.offsetTop = 100;
  engine.reader.clientWidth = 400;
  engine.reader.scrollHeight = 1100;
  engine.media.offsetLeft = 500;
  engine.media.clientWidth = 640;
  engine.main.children = [engine.heading, engine.reader, engine.media];
  engine.media.parentElement = engine.main;
  engine.mappings.set("video", [engine.media]);
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
  const detected = await engine.ask("ENGINE_PROBE", { settings });
  assert.equal(detected.candidate.type, "text", "player alignment does not mean that an independent text reader has been read");
  assert.equal(detected.candidate.readingBeforeVideo, true);
  await engine.ask("ENGINE_RUN", { settings });
  const bottom = engine.reader.scrollHeight - engine.reader.clientHeight;
  for (let step = 0; step < 20 && engine.reader.scrollTop < bottom; step++) {
    assert.equal(engine.media.playCalls, 0, "video cannot play while the independent reader still has unread scroll range");
    await engine.clock.advance(1250);
  }
  assert.equal(engine.reader.scrollTop, bottom);
  await engine.clock.advance(350);
  await advanceUntil(engine, () => engine.media.playCalls === 1);
  assert.equal(engine.media.playCalls, 1);
  assert.equal(engine.context.document.scrollingElement.scrollTop, 0);
  assert.equal(doneCount(engine), 0);
});

test("parent lesson text blocks a child player's attempt to scroll its iframe past the unread text", async () => {
  const ancestor = createContent();
  const child = createContent({ type: "video" });
  const frame = element("iframe", "", { src: "https://media.huawei.example/player" });
  Object.assign(frame, { offsetTop: 1800, clientHeight: 900, clientWidth: 1200, parentElement: ancestor.main, contentWindow: child.context });
  ancestor.reader.style.overflowY = "visible";
  ancestor.reader.clientHeight = ancestor.reader.scrollHeight = 1400;
  ancestor.main.children.push(frame);
  ancestor.mappings.set("iframe", [frame]);
  const root = ancestor.context.document.scrollingElement;
  root.scrollHeight = 5000;
  ancestor.context.postMessage = message => ancestor.emitWindow("message", { data: message, source: child.context });
  child.context.postMessage = message => child.emitWindow("message", { data: message, source: ancestor.context });
  child.context.parent = ancestor.context;
  child.context.top = ancestor.context;
  const probe = await ancestor.ask("ENGINE_PROBE", { viewportEnabled: true });
  assert.equal(probe.candidate.type, "text");
  assert.equal(probe.candidate.readingBeforeVideo, true);
  assert.ok(probe.candidate.score > 150, "the parent reading candidate must be able to win frame arbitration");
  await child.ask("ENGINE_RUN");
  await ancestor.clock.advance(1000);
  await child.clock.settle();
  assert.equal(root.scrollTop, 0, "a child alignment request cannot bypass the parent's reading intervals");
  assert.equal(child.media.playCalls, 0);
});

test("an already centered video plays without periodic reading-scroll movement", async () => {
  const engine = createContent({ type: "video", title: "网络演示 · 视频" });
  engine.main.style.overflowY = "auto";
  engine.main.clientHeight = 900;
  engine.main.scrollHeight = 5000;
  engine.context.document.scrollingElement.scrollHeight = 6000;
  await engine.ask("ENGINE_RUN", { settings: { scrollEnabled: true, scrollIntervalSeconds: 1 } });
  await engine.clock.advance(12_000);
  assert.equal(engine.media.playCalls, 1);
  assert.equal(engine.reader.scrolls.length, 0);
  assert.equal(engine.main.scrolls.length, 0);
  assert.equal(engine.context.document.scrollingElement.scrolls.length, 0);
  assert.equal(doneCount(engine), 0, "video completion still requires its real ended event");
});

test("an offscreen video is moved into the viewport center before its first play call", async () => {
  const engine = createContent({ type: "video", mediaTop: 1800 });
  engine.context.document.scrollingElement.scrollHeight = 5000;
  const started = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 } });
  assert.equal(started.ok, true);
  assert.equal(engine.media.playCalls, 0, "scrolling into position must be verified before autoplay");
  await advanceUntil(engine, () => engine.media.playCalls === 1);
  const rect = engine.media.getBoundingClientRect();
  assert.ok(Math.abs(rect.top + rect.height / 2 - 450) <= 90, "the actual player center reaches the browser viewport center");
  assert.equal(engine.media.playCalls, 1);
  const scrollCount = engine.context.document.scrollingElement.scrolls.length;
  await engine.clock.advance(12_000);
  assert.equal(engine.context.document.scrollingElement.scrolls.length, scrollCount, "reading scroll remains suspended during playback");
});

test("a player that cannot be centered never starts automatically", async () => {
  const engine = createContent({ type: "video", mediaTop: 1800 });
  await engine.ask("ENGINE_RUN");
  await engine.clock.advance(15_000);
  assert.equal(engine.media.playCalls, 0);
  assert.equal(doneCount(engine), 0);
  assert.match(engine.snapshot().detail, /居中|中间|滚动|可视/);
});

test("a video that already ended outside the reading area is released instead of blocking the task", async () => {
  const engine = createContent({ type: "video", mediaTop: 1800 });
  engine.media.ended = true;
  engine.media.currentTime = engine.media.duration;
  await engine.ask("ENGINE_RUN");
  await engine.clock.advance(15_000);
  assert.equal(engine.media.playCalls, 0, "a finished video is never replayed just to unblock the flow");
  assert.equal(doneCount(engine), 0);
  assert.doesNotMatch(engine.snapshot().detail, /无可继续向下滚动/);
  assert.equal(engine.snapshot().phase, "waiting_completion");
});

test("pause and stop cancel deferred video centering and autoplay", async () => {
  for (const action of ["ENGINE_PAUSE", "ENGINE_STOP"]) {
    const engine = createContent({ type: "video", mediaTop: 1800 });
    engine.context.document.scrollingElement.scrollHeight = 5000;
    await engine.ask("ENGINE_RUN");
    assert.equal(engine.media.playCalls, 0);
    await engine.ask(action);
    await engine.clock.advance(10_000);
    assert.equal(engine.media.playCalls, 0, `${action} cancels the queued playback`);
    assert.equal(doneCount(engine), 0);
  }
});

test("a video inside an unresponsive ancestor frame cannot mistake local centering for browser centering", async () => {
  const engine = createContent({ type: "video" });
  const requests = [];
  engine.context.parent = { postMessage(message) { requests.push(message); } };
  engine.context.top = {};
  await engine.ask("ENGINE_RUN");
  await engine.clock.advance(10_000);
  assert.ok(requests.length > 0, "the child must ask its actual ancestor to verify alignment");
  assert.equal(engine.media.playCalls, 0);
  assert.match(engine.snapshot().detail, /权限|内嵌|父|居中|中间/);
});

test("a real ancestor frame centers the projected video in the top viewport before authorizing play", async () => {
  const ancestor = createContent();
  ancestor.reader.innerText = ancestor.reader.textContent = "";
  const child = createContent({ type: "video" });
  const frame = element("iframe", "", { src: "https://media.huawei.example/player" });
  frame.offsetTop = 1800;
  frame.clientHeight = 900;
  frame.clientWidth = 1200;
  frame.parentElement = ancestor.context.document.scrollingElement;
  frame.contentWindow = child.context;
  ancestor.mappings.set("iframe", [frame]);
  ancestor.context.document.scrollingElement.scrollHeight = 5000;
  ancestor.context.postMessage = (message) => ancestor.emitWindow("message", { data: message, source: child.context });
  child.context.postMessage = (message) => child.emitWindow("message", { data: message, source: ancestor.context });
  child.context.parent = ancestor.context;
  child.context.top = ancestor.context;
  await ancestor.ask("ENGINE_PROBE", { viewportEnabled: true });
  await child.ask("ENGINE_RUN");
  assert.equal(child.media.playCalls, 0, "a child-local centered rectangle does not start playback yet");
  await ancestor.clock.advance(1000);
  await child.clock.settle();
  const topCenter = frame.getBoundingClientRect().top + child.media.getBoundingClientRect().top + child.media.clientHeight / 2;
  assert.ok(Math.abs(topCenter - 450) <= 80);
  assert.equal(child.media.playCalls, 1);
});

test("embedded video completion returns to its owner to read trailing text before platform completion", async () => {
  const owner = createContent();
  const child = createContent({ type: "video" });
  const tail = element("article", "内嵌视频之后仍需要阅读的尾部正文".repeat(60));
  Object.assign(tail, { offsetTop: 900, clientHeight: 800, scrollHeight: 800, parentElement: owner.main, ownerDocument: owner.context.document });
  owner.reader.style.overflowY = "visible";
  owner.reader.clientHeight = owner.reader.scrollHeight = 200;
  const frame = element("iframe", "", { src: "https://media.huawei.example/player" });
  Object.assign(frame, { offsetTop: 235, clientHeight: 430, clientWidth: 1200, parentElement: owner.main, contentWindow: child.context });
  owner.main.children = [owner.heading, owner.reader, frame, tail];
  owner.mappings.set("iframe", [frame]);
  owner.mappings.set(".reader-content", [owner.reader, tail]);
  const root = owner.context.document.scrollingElement;
  root.scrollHeight = 2000;
  owner.context.postMessage = message => owner.emitWindow("message", { data: message, source: child.context });
  child.context.postMessage = message => child.emitWindow("message", { data: message, source: owner.context });
  child.context.parent = owner.context;
  child.context.top = owner.context;
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
  await owner.ask("ENGINE_RUN", { settings, resetPosition: true, runId: "owner-page" });
  const request = owner.outbound.find(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.ok(request, "the owner delegates only its next iframe in page order");
  const ready = child.outbound.find(message => message.type === "ENGINE_EMBEDDED_READY");
  assert.equal(ready?.token, request.token);
  const invalid = await child.ask("ENGINE_EMBEDDED_RUN", { settings, resetPosition: true, token: "wrong-token", runId: "child-page" });
  assert.equal(invalid.ok, false, "a different frame binding cannot start the child engine");
  await child.ask("ENGINE_EMBEDDED_RUN", { settings, resetPosition: true, token: request.token, runId: "child-page" });
  await owner.clock.advance(350);
  await child.clock.settle();
  assert.equal(child.media.playCalls, 1);
  const childPlaying = child.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS").at(-1);
  assert.equal(childPlaying.token, request.token);
  await owner.ask("ENGINE_EMBEDDED_STATUS", { token: request.token, runId: "owner-page", snapshot: childPlaying.snapshot });
  assert.equal(owner.snapshot().phase, "playing");
  assert.equal(root.scrollTop, 0);
  child.media.finish();
  // The child now confirms the chapter tail (scroll + settle window) before it
  // hands the page back, so allow for the settle window on top of one step.
  await child.clock.advance(4000);
  const returned = child.outbound.find(message => message.type === "ENGINE_EMBEDDED_DONE");
  assert.ok(returned);
  assert.equal(doneCount(child), 0, "an embedded frame does not finish the parent course task");
  await owner.ask("ENGINE_EMBEDDED_STATUS", { token: request.token, runId: "owner-page", snapshot: returned.snapshot });
  await owner.ask("ENGINE_EMBEDDED_RETURN", { token: "stale-token", runId: "owner-page", ok: true });
  assert.equal(owner.snapshot().flow.embeddedActive, true);
  await owner.ask("ENGINE_EMBEDDED_RETURN", { token: request.token, runId: "owner-page", ok: true });
  assert.equal(owner.snapshot().flow.embeddedActive, false);
  assert.equal(doneCount(owner), 0);
  await advanceUntil(owner, () => root.scrollTop === root.scrollHeight - root.clientHeight);
  assert.equal(doneCount(owner), 0, "the owner still needs the platform's current-task completion signal");
  owner.active.setAttribute("data-completed", "true");
  await owner.clock.advance(2000);
  assert.equal(doneCount(owner), 1);
});

test("ancestor alignment ignores requests whose source is not one of its real child frames", async () => {
  const ancestor = createContent();
  ancestor.context.document.scrollingElement.scrollHeight = 5000;
  await ancestor.ask("ENGINE_PROBE", { viewportEnabled: true });
  let replies = 0;
  ancestor.emitWindow("message", { source: { postMessage() { replies++; } }, data: {
    protocol: "itc-flow-viewport-v1", kind: "request", requestId: "unmapped-source", depth: 0,
    rect: { left: 0, top: 1800, width: 800, height: 430 }, viewport: { width: 1200, height: 900 }
  } });
  await ancestor.clock.advance(1000);
  assert.equal(ancestor.context.document.scrollingElement.scrolls.length, 0);
  assert.equal(replies, 0);
});

test("ancestor alignment rechecks layout after awaiting a more distant parent confirmation", async () => {
  const ancestor = createContent();
  ancestor.reader.innerText = ancestor.reader.textContent = "";
  const child = createContent({ type: "video" });
  const frame = element("iframe");
  Object.assign(frame, { offsetTop: 1800, clientHeight: 900, clientWidth: 1200, parentElement: ancestor.context.document.scrollingElement, contentWindow: child.context });
  ancestor.mappings.set("iframe", [frame]);
  ancestor.context.document.scrollingElement.scrollHeight = 5000;
  let distantRequest;
  const distantParent = { postMessage(message) { distantRequest = message; } };
  ancestor.context.parent = distantParent;
  ancestor.context.top = {};
  ancestor.context.postMessage = message => ancestor.emitWindow("message", { data: message, source: child.context });
  const replies = [];
  child.context.postMessage = message => { replies.push(message); child.emitWindow("message", { data: message, source: ancestor.context }); };
  child.context.parent = ancestor.context;
  child.context.top = {};
  await ancestor.ask("ENGINE_PROBE", { viewportEnabled: true });
  await child.ask("ENGINE_RUN");
  await ancestor.clock.advance(350);
  assert.ok(distantRequest, "the intermediate frame must await its own ancestor");
  frame.offsetTop += 300;
  ancestor.emitWindow("message", { source: distantParent, data: { protocol: "itc-flow-viewport-v1", kind: "response", requestId: distantRequest.requestId, centered: true } });
  await ancestor.clock.settle();
  await child.clock.settle();
  assert.equal(replies.at(-1)?.centered, false, "a previously centered projection is invalid after layout drift");
  assert.equal(child.media.playCalls, 0);
});

test("a video moving while awaiting ancestor confirmation cannot play from a stale measurement", async () => {
  const engine = createContent({ type: "video" });
  let request;
  const ancestor = { postMessage(message) { request = message; } };
  engine.context.parent = ancestor;
  engine.context.top = {};
  await engine.ask("ENGINE_RUN");
  assert.ok(request);
  engine.media.offsetTop += 200;
  engine.emitWindow("message", { source: ancestor, data: { protocol: "itc-flow-viewport-v1", kind: "response", requestId: request.requestId, centered: true } });
  await engine.clock.settle();
  assert.equal(engine.media.playCalls, 0);
  assert.equal(doneCount(engine), 0);
});

test("a video starts muted and its actual end continues the same page without completing the task", async () => {
  const engine = createContent({ type: "video", title: "网络演示 · 视频" });
  const started = await engine.ask("ENGINE_RUN", { settings: { muteVideo: true } });
  assert.equal(started.candidate.type, "video");
  assert.equal(engine.media.playCalls, 1);
  assert.equal(engine.media.muted, true);
  await engine.clock.advance(120_000);
  assert.equal(doneCount(engine), 0, "wall-clock time cannot complete a video");
  engine.media.finish();
  await engine.clock.settle();
  assert.equal(doneCount(engine), 0);
  assert.equal(engine.media.muted, false);
  engine.media.emit("ended");
  assert.equal(doneCount(engine), 0);
  await engine.clock.advance(3000);
  assert.equal(engine.snapshot().phase, "waiting_completion");
});

test("a paused video cannot complete via a late ended event", async () => {
  const engine = createContent({ type: "video", title: "网络演示 · 视频" });
  await engine.ask("ENGINE_RUN");
  await engine.ask("ENGINE_PAUSE");
  assert.equal(engine.media.paused, true);
  engine.media.finish();
  assert.equal(doneCount(engine), 0);
  assert.equal(engine.snapshot().phase, "paused");
});

test("a stale queued pause event cannot block a video that has already resumed playing", async () => {
  const engine = createContent({ type: "video" });
  engine.media.paused = false;
  await engine.ask("ENGINE_RUN");
  assert.equal(engine.media.paused, false);
  engine.media.emit("pause");
  assert.equal(engine.snapshot().phase, "playing");
  assert.equal(engine.media.playCalls, 1, "an obsolete event must not cause another centering/play cycle");
});

test("a stale queued playing event cannot complete or unblock a currently paused video", async () => {
  const engine = createContent({ type: "video" });
  await engine.ask("ENGINE_RUN");
  engine.media.pause();
  assert.equal(engine.snapshot().phase, "blocked");
  engine.media.emit("playing");
  assert.equal(engine.snapshot().phase, "blocked");
  assert.equal(doneCount(engine), 0);
});

test("a late rejection of an old play request cannot block a newer run reusing the same video", async () => {
  const engine = createContent({ type: "video" });
  const originalPlay = engine.media.play;
  let rejectOldPlay;
  engine.media.play = function () {
    if (rejectOldPlay) return originalPlay.call(this);
    this.playCalls++;
    this.paused = false;
    this.emit("playing");
    return new Promise((resolve, reject) => { rejectOldPlay = reject; });
  };
  await engine.ask("ENGINE_RUN", { runId: "old-run" });
  assert.equal(typeof rejectOldPlay, "function");
  const videoNode = engine.media;
  await engine.ask("ENGINE_RUN", { runId: "new-run" });
  assert.equal(engine.media, videoNode);
  assert.equal(engine.snapshot().phase, "playing");
  rejectOldPlay(Object.assign(new Error("Old autoplay request denied after restart"), { name: "NotAllowedError" }));
  await engine.clock.settle();
  assert.equal(engine.snapshot().phase, "playing");
  assert.equal(engine.snapshot().runId, "new-run");
  assert.equal(engine.media.paused, false);
  assert.equal(doneCount(engine), 0);
});

test("autoplay denial is surfaced as blocked and never counted as completion", async () => {
  const engine = createContent({ type: "video", title: "网络演示 · 视频", autoplayBlocked: true });
  await engine.ask("ENGINE_RUN");
  assert.equal(engine.snapshot().phase, "blocked");
  assert.match(engine.snapshot().detail, /自动播放|点击/);
  await engine.clock.advance(60_000);
  assert.equal(doneCount(engine), 0);
});

test("a task title without substantive reader content cannot become a reading task", async () => {
  const engine = createContent({ textLength: 8 });
  const result = await engine.ask("ENGINE_PROBE");
  assert.equal(result.candidate, null);
  assert.equal(result.reason, "not_found");
});

test("manual tasks and invalid custom selectors are rejected before running a timer", async () => {
  const quiz = createContent({ title: "章节测验", type: "quiz" });
  assert.equal((await quiz.ask("ENGINE_PROBE")).reason, "manual_action");
  const engine = createContent();
  const invalid = await engine.ask("ENGINE_PROBE", { settings: { selectors: { next: "[" } } });
  assert.equal(invalid.reason, "invalid_selector");
  assert.equal((await engine.ask("ENGINE_RUN")).ok, false);
  await engine.clock.advance(60_000);
  assert.equal(doneCount(engine), 0);
});

test("the first next click is allowed immediately, repeats are suppressed, and disabled ends the course", async () => {
  const engine = createContent();
  const first = await engine.ask("ENGINE_ADVANCE", { settings: { selectors: { next: "#next" } } });
  assert.equal(first.clicked, true);
  assert.equal(engine.next.clicks, 1);
  assert.equal((await engine.ask("ENGINE_ADVANCE")).clicked, false);
  assert.equal(engine.next.clicks, 1);
  await engine.clock.advance(1800);
  engine.next.disabled = true;
  assert.equal((await engine.ask("ENGINE_ADVANCE")).reason, "end");
  assert.equal(engine.next.clicks, 1);
});

test("replacing a reader DOM element stops its old timer and reports a same-key replacement", async () => {
  const engine = createContent();
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 10, scrollEnabled: false } });
  await engine.clock.advance(3000);
  const replacement = element("article", "新的学习内容".repeat(100));
  replacement.parentElement = engine.main;
  engine.mappings.set(".reader-content", [replacement]);
  engine.reader.isConnected = false;
  engine.mutate();
  await engine.clock.advance(550);
  const changed = engine.outbound.filter((message) => message.type === "ENGINE_CHANGED").at(-1);
  assert.equal(changed.elementReplaced, true);
  await engine.clock.advance(20_000);
  assert.equal(doneCount(engine), 0);
});

test("manual route changes reuse the reader node while retiring the previous task's scroll timer", async () => {
  const engine = createContent();
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
  const started = await engine.ask("ENGINE_RUN", { settings });
  await engine.clock.advance(1500);
  const originalReader = engine.reader;
  engine.reader.innerText = engine.reader.textContent = "手动切换后的新课程正文".repeat(60);
  engine.context.location.hash = "#manual-page-two";
  engine.emitWindow("hashchange");
  await engine.clock.advance(550);
  const changed = engine.outbound.filter(message => message.type === "ENGINE_CHANGED").at(-1);
  assert.ok(changed?.candidate);
  assert.notEqual(changed.candidate.key, started.candidate.key, "the same directory task and reader may belong to a new SPA route");
  assert.equal(engine.reader, originalReader);
  const position = engine.reader.scrollTop;
  await engine.clock.advance(5000);
  assert.equal(engine.reader.scrollTop, position, "the previous page's timer cannot keep scrolling the reused node");
  const restarted = await engine.ask("ENGINE_RUN", { settings });
  assert.equal(restarted.snapshot.scroll.movements, 0);
  assert.equal(engine.reader.scrollTop, 0, "a fresh run on the new manual page starts at its top");
  await engine.clock.advance(1250);
  assert.ok(engine.reader.scrollTop > 0, "a new run can control the reused reader on the newly selected page");
  assert.equal(doneCount(engine), 0);
});

test("reinjection is idempotent and never installs a second runner", async () => {
  const engine = createContent();
  vm.runInContext(engine.script, engine.context);
  assert.equal(engine.outbound.filter((message) => message.type === "ENGINE_READY").length, 1);
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: false } });
  await engine.clock.advance(5000);
  assert.equal(doneCount(engine), 0);
});

test("short content in a recognized reader is usable without accepting a short generic article", async () => {
  const recognized = createContent({ textLength: 80 });
  const accepted = await recognized.ask("ENGINE_PROBE");
  assert.equal(accepted.candidate?.type, "text", "a real short lesson inside a known reader should not remain undetected");

  const generic = createContent({ textLength: 80, title: "普通页面" });
  generic.mappings.delete(".reader-content");
  generic.mappings.delete(".task-item.active");
  generic.mappings.delete("[data-task-id].active");
  generic.mappings.set("article", [generic.reader]);
  const rejected = await generic.ask("ENGINE_PROBE");
  assert.equal(rejected.candidate, null, "the relaxed reader threshold must not turn unrelated article snippets into lessons");
});

test("a document type marker in the course navigation cannot be mistaken for the document reader", async () => {
  const engine = createContent({ type: "document", title: "网络基础 · 文档" });
  engine.active.setAttribute("data-task-type", "document");
  engine.mappings.delete(".document-viewer");
  engine.mappings.set("[data-task-type='document']", [engine.active]);
  const probe = await engine.ask("ENGINE_PROBE");
  assert.equal(probe.candidate, null, "a visible document-labelled directory button has no readable document content");
  assert.equal(doneCount(engine), 0);
});

test("the last screen of a chapter is settled and re-reported before the task completes", async () => {
  const engine = createContent({ textLength: 600 });
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
  await engine.clock.advance(60_000);
  const tail = engine.reader.scrollHeight - engine.reader.clientHeight;
  assert.equal(engine.reader.scrollTop, tail, "the chapter tail should be reached");
  let trace = (await engine.ask("ENGINE_PROBE")).diagnostics.runtime.trace;
  assert.ok(trace.some(entry => entry.action === "settle-tail"), "the tail settle step should appear in the trace");
  assert.equal(doneCount(engine), 0);

  // A late-loading last screen must still be reached: the reader reports
  // completion from its own position, so the tail is settled again.
  engine.reader.scrollHeight = tail + engine.reader.clientHeight + 120;
  await engine.clock.advance(6_000);
  const grown = engine.reader.scrollHeight - engine.reader.clientHeight;
  assert.equal(engine.reader.scrollTop, grown, "the grown tail should be reached as well");
  trace = (await engine.ask("ENGINE_PROBE")).diagnostics.runtime.trace;
  assert.ok(trace.filter(entry => entry.action === "settle-tail").length >= 2, "each new tail should be settled once");
  assert.ok(["bottom", "waiting_completion"].includes(engine.snapshot().scroll.state));
  assert.equal(doneCount(engine), 0);
});

test("a chapter that grows while its end is confirmed is read to the new end", async () => {
  const engine = createContent({ textLength: 600 });
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1, scrollEnabled: true } });
  const bottom = () => engine.reader.scrollHeight - engine.reader.clientHeight;
  let confirming = false;
  for (let guard = 0; guard < 400 && !confirming; guard += 1) {
    await engine.clock.advance(200);
    confirming = String(engine.snapshot().detail || "").includes("正在确认末尾位置");
  }
  assert.ok(confirming, "the tail confirmation window must be observable");
  assert.equal(engine.reader.scrollTop, bottom(), "the first tail must be reached before it grows");
  // The Word frame or images at the end mount while the tail is being confirmed.
  engine.reader.scrollHeight = bottom() + engine.reader.clientHeight + 500;
  await engine.clock.advance(3_000);
  const grown = engine.reader.scrollHeight - engine.reader.clientHeight;
  assert.equal(engine.reader.scrollTop, grown, "the confirmed tail must include the grown part");
  const trace = (await engine.ask("ENGINE_PROBE")).diagnostics.runtime.trace;
  assert.ok(trace.some(entry => entry.action === "settle-grew"), "growth during confirmation should be traced");
  assert.equal(doneCount(engine), 0);
});

test("probe diagnostics describe visible media and iframe origins without exporting body text or URL tokens", async () => {
  const engine = createContent();
  engine.context.location = new URL("https://e.huawei.com/course/test?auth=fixture-query-token#fixture-route-token");
  engine.reader.innerText = engine.reader.textContent = "fixture-private-body".repeat(30);
  const remote = element("iframe", "", { src: "https://media.huawei.example/player?token=fixture-player-token#fixture-player-route" });
  const blank = element("iframe", "", { src: "about:blank", srcdoc: "fixture-private-srcdoc" });
  blank.hidden = true;
  engine.mappings.set("iframe", [remote, blank]);
  engine.mappings.set("iframe[src]", [remote, blank]);
  engine.context.document.readyState = "complete";

  const response = await engine.ask("ENGINE_PROBE");
  const diagnostics = response.diagnostics;
  assert.equal(diagnostics.path, "https://e.huawei.com/course/test");
  assert.equal(diagnostics.readyState, "complete");
  assert.equal(diagnostics.iframeCount, 2);
  assert.equal(diagnostics.visibleIframeCount, 1);
  assert.equal(diagnostics.frames[0].origin, "https://media.huawei.example");
  assert.equal(diagnostics.frames[0].sourceType, "http");
  assert.equal(diagnostics.frames[1].sourceType, "blank");
  assert.equal(diagnostics.frames[1].visible, false);
  assert.ok(diagnostics.readerCandidates.some((candidate) => candidate.selector === ".reader-content" && candidate.textLength > 100));
  const exported = JSON.stringify(diagnostics);
  assert.doesNotMatch(exported, /fixture-(?:query|route|player|private)/, "diagnostics must not include page text, iframe HTML, or credential-bearing URL components");
});
