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

test("unloading the previous chapter inside a stable textbook reader does not stop or reset the next chapter", async () => {
  const { engine, root, host, chapterBox, first, next } = chapterReader();
  const run = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "chapter-continuity-run", resetPosition: true });
  assert.equal(run.ok, true);
  host.scrollTop = 4208;
  const position = host.scrollTop;
  const scrollCount = host.scrolls.length;
  first.isConnected = false;
  chapterBox.children = [next];
  engine.mutate();
  await engine.clock.advance(600);
  const diagnostic = await engine.ask("ENGINE_PROBE");
  assert.equal(diagnostic.diagnostics.runtime.running, true,
    "the stable textbook host remains active after its old first chapter node is removed");
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_CHANGED" && message.elementReplaced), false,
    "a replaced content leaf is not a replaced course reader");
  await engine.clock.advance(3000);
  assert.ok(host.scrollTop > position, "continue down the next chapter using the existing timer");
  assert.equal(host.scrolls.slice(scrollCount).some(item => item.top < position), false, "all chapter continuation steps preserve forward progress");
  assert.equal(root.scrollTop, 0, "chapter continuity never moves the outer page");
});

test("a real route change still retires the old textbook run", async () => {
  const { engine, host } = chapterReader();
  const run = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "old-route", resetPosition: true });
  host.scrollTop = 4208;
  engine.context.location.hash = "#a-different-course-task";
  engine.emitWindow("hashchange");
  await engine.clock.advance(1600);
  const diagnostic = await engine.ask("ENGINE_PROBE");
  assert.equal(diagnostic.diagnostics.runtime.running, false, "an actual new route cannot inherit old chapter progress");
  assert.ok(engine.outbound.some(message => message.type === "ENGINE_CHANGED" && message.candidate?.key !== run.candidate.key));
});

test("a textbook chapter menu following the reading position cannot turn the same reader into a fresh task", async () => {
  const { engine, host } = chapterReader({ chapterMenu: true });
  const run = await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "menu-continuity", resetPosition: true });
  assert.equal(run.ok, true);
  host.scrollTop = 4208;
  engine.active.setAttribute("data-task-id", "chapter-two");
  engine.active.innerText = engine.active.textContent = "教材下一章节";
  engine.mutate();
  await engine.clock.advance(600);
  const diagnostic = await engine.ask("ENGINE_PROBE");
  assert.equal(diagnostic.candidate.key, run.candidate.key, "the scrolling chapter marker is not the identity of the complete textbook task");
  assert.equal(diagnostic.diagnostics.runtime.running, true);
  await engine.clock.advance(3000);
  assert.ok(host.scrollTop > 4208, "the next chapter continues from its existing reading position");
});

test("recreating an already completed chapter video with a new temporary source preserves its completed identity", async () => {
  for (const replacementSource of ["https://example.test/refreshed-lesson.mp4", "blob:https://example.test/a-new-media-object"]) {
    const fixture = chapterReader();
    const { engine, host, chapterBox, first, next, video, append, prepare, makeChapter } = fixture;
    const original = video("stable-lesson-video", 154.5, "https://example.test/original-lesson.mp4");
    append(first, [original]);
    await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "completed-video-remount", resetPosition: true });
    await engine.clock.advance(1000);
    assert.equal(original.playCalls, 1);
    original.finish();
    await engine.clock.advance(1500);
    const position = host.scrollTop;
    assert.ok(position > 0);
    assert.equal(engine.snapshot().flow.videosCompleted, 1);
    const played = Array.from(engine.snapshot().flow.playedMediaIds);
    first.isConnected = original.isConnected = false;
    const replacementChapter = prepare(makeChapter("chapter-one", 0, 4138));
    const replacementVideo = video("stable-lesson-video", position + 154.5, replacementSource);
    append(replacementChapter, [replacementVideo]); append(chapterBox, [replacementChapter, next]);
    engine.mutate();
    await engine.clock.advance(4000);
    assert.equal(replacementVideo.playCalls, 0, "chapterId and videoId survive a renewed signed or blob URL");
    assert.equal(engine.snapshot().flow.videosCompleted, 1);
    assert.deepEqual(Array.from(engine.snapshot().flow.playedMediaIds), played);
    assert.ok(host.scrollTop > position, "remounted completed video cannot block reading the next content");
    assert.equal(engine.snapshot().runId, "completed-video-remount");
  }
});

test("replacing a playing textbook video retires its old listeners and resumes timed reading after the replacement ends", async () => {
  const { engine, host, first, video, append } = chapterReader();
  const original = video("recreated-active-video", 154.5, "blob:https://example.test/old-active-player");
  append(first, [original]);
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "active-video-replacement", resetPosition: true });
  await engine.clock.advance(1000);
  assert.equal(original.playCalls, 1);
  original.isConnected = false;
  const replacement = video("recreated-active-video", 154.5, "blob:https://example.test/new-active-player");
  append(first, [replacement]);
  engine.mutate();
  await engine.clock.advance(1200);
  assert.equal(replacement.playCalls, 1, "the new connected player may reenter the same reading flow");
  original.emit("playing"); original.emit("pause"); original.finish();
  await engine.clock.settle();
  assert.equal(original.playCalls, 1, "detached player events cannot trigger its old playback gate again");
  assert.equal(engine.snapshot().flow.videosCompleted, 0, "a detached ended event does not count as the new player's completion");
  assert.equal(engine.snapshot().phase, "playing");
  replacement.finish();
  const position = host.scrollTop;
  await engine.clock.advance(4000);
  assert.equal(engine.snapshot().flow.videosCompleted, 1);
  assert.ok(host.scrollTop > position, "replacement completion must rearm the real reading timer");
  assert.equal(engine.snapshot().runId, "active-video-replacement");
});

test("a temporarily empty chapter waits within the same embedded run, then resumes its timer and completed media history", async () => {
  const { engine, root, host, chapterBox, first, next, video, append, prepare, makeChapter } = chapterReader();
  const original = video("chapter-loading-video", 154.5, "https://example.test/chapter-loading.mp4");
  append(first, [original]);
  const parent = { postMessage() {} }, token = "transient-chapter-binding";
  engine.context.parent = parent;
  engine.emitWindow("message", { source: parent, data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token } });
  // This fixture's reader is fully visible; the parent transport is exercised
  // separately. Keep the binding while using the local viewport for geometry.
  engine.context.parent = engine.context;
  const latest = () => engine.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS").at(-1)?.snapshot;
  await engine.ask("ENGINE_EMBEDDED_RUN", { settings: { scrollIntervalSeconds: 1, selectors: { completed: "#chapterCompleteMarker" } },
    token, runId: "transient-chapter-run", resetPosition: true });
  await engine.clock.advance(1000);
  assert.equal(original.playCalls, 1);
  original.finish();
  await engine.clock.advance(1500);
  assert.equal(latest().flow.videosCompleted, 1);
  const played = Array.from(latest().flow.playedMediaIds);
  const position = host.scrollTop = host.scrollHeight - host.clientHeight;
  const marker = prepare(element("div", "", { id: "chapterCompleteMarker" }));
  marker.parentElement = root; root.children.push(marker);
  first.isConnected = next.isConnected = original.isConnected = false;
  append(chapterBox, []);
  engine.mutate();
  await engine.clock.advance(1800);
  const pending = await engine.ask("ENGINE_PROBE");
  assert.equal(pending.candidate.chapterLoading, true);
  assert.equal(pending.diagnostics.runtime.running, true);
  assert.equal(latest().phase, "waiting");
  assert.equal(latest().scroll.state, "loading_chapter");
  assert.equal(host.scrollTop, position, "loading a chapter cannot perform an otherwise due reading step");
  assert.equal(latest().flow.videosCompleted, 1);
  assert.deepEqual(Array.from(latest().flow.playedMediaIds), played);
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false,
    "an empty chapter cannot return complete even at the scrollbar limit with a platform-complete marker");
  const loaded = prepare(makeChapter("new-loaded-chapter", position, 2200));
  host.scrollHeight = 7305;
  append(chapterBox, [loaded]);
  engine.mutate();
  await engine.clock.advance(4000);
  assert.ok(host.scrollTop > position, "loaded content rearms timed downward reading");
  assert.equal(latest().runId, "transient-chapter-run");
  assert.equal(latest().flow.videosCompleted, 1);
  assert.deepEqual(Array.from(latest().flow.playedMediaIds), played);
  const reports = engine.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS");
  assert.ok(reports.length > 3);
  assert.ok(reports.every(message => message.token === token && message.runId === "transient-chapter-run"),
    "loading and recovery preserve the same parent binding");
});

test("a real route change during an empty chapter still retires its old run", async () => {
  const { engine, chapterBox, host, append, first, next } = chapterReader();
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 }, runId: "blank-old-route", resetPosition: true });
  first.isConnected = next.isConnected = false;
  append(chapterBox, []);
  engine.mutate();
  await engine.clock.advance(600);
  assert.equal((await engine.ask("ENGINE_PROBE")).candidate.chapterLoading, true);
  const position = host.scrollTop;
  engine.context.location.hash = "#different-task-while-empty";
  engine.emitWindow("hashchange");
  await engine.clock.advance(2200);
  const result = await engine.ask("ENGINE_PROBE");
  assert.equal(result.diagnostics.runtime.running, false);
  assert.equal(result.candidate, null, "a loading fallback is scoped to the original course route");
  assert.equal(host.scrollTop, position, "a loading chapter and subsequent new route cannot consume an old reading timer");
});
