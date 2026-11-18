"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element, mediaElement } = require("./helpers/content-harness.cjs");

const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const append = (parent, children) => { parent.children = children; children.forEach(child => { child.parentElement = parent; }); };

function textbook() {
  const engine = createContent();
  const root = engine.context.document.scrollingElement;
  Object.assign(root, { scrollHeight: 7000, scrollTop: 180 });
  const shell = element("div");
  shell.className = "information-cont edmFull";
  shell.style.overflowY = "auto";
  Object.assign(shell, { offsetTop: 180, clientHeight: 811, scrollHeight: 1305 });
  engine.main.className = "reader-mobile__body";
  engine.main.style.overflowY = "hidden";
  Object.assign(engine.main, { offsetTop: 200, clientHeight: 625, scrollHeight: 625 });
  const host = element("div", "", { id: "reader-container" });
  host.style.overflowY = "auto";
  Object.assign(host, { clientHeight: 625, scrollHeight: 3600 });
  const tiny = element("div", "课程简介".repeat(30));
  tiny.className = "reader-chapter-content w-e-text";
  tiny.style.overflowY = "hidden";
  Object.assign(tiny, { clientHeight: 82, scrollHeight: 105 });
  const body = element("div", "数字教材正文需要按页面顺序逐步阅读。".repeat(200));
  body.className = "reader-chapter-content w-e-text";
  body.style.overflowY = "hidden";
  Object.assign(body, { offsetTop: 82, clientHeight: 3500, scrollHeight: 3500 });
  const chapterBox = element("div", "", { id: "reader-chapter-box" });
  const firstText = element("p", "第一段视频之前的教材文字".repeat(90));
  Object.assign(firstText, { clientHeight: 700, scrollHeight: 700 });
  const makeVideo = (id, offsetTop) => {
    const row = element("span"); row.className = "td";
    Object.assign(row, { offsetTop, clientHeight: 50, scrollHeight: 50 });
    const input = element("input", "", { id: `check_${id}` }); input.className = "insertVideoCheck"; input.checked = false;
    const title = element("span", "教材视频标题", { id: `video_title_span_${id}` }); title.className = "videoTitlepc-new";
    Object.assign(title, { clientHeight: 40, scrollHeight: 40 });
    const wrapper = element("span"); wrapper.className = "element-new";
    wrapper.style.overflowY = wrapper.style.overflowX = "hidden";
    Object.assign(wrapper, { offsetTop: 50, clientHeight: 0, scrollHeight: 186 });
    const media = mediaElement({ src: `https://e.huawei.com/media/${id}.mp4` }); media.className = "insertVideo cres";
    Object.assign(media, { clientHeight: 180, scrollHeight: 180 });
    append(wrapper, [media]); append(row, [input, title, wrapper]);
    input.click = () => { input.clicks += 1; input.checked = !input.checked; wrapper.clientHeight = input.checked ? 186 : 0; };
    return { row, input, title, wrapper, media };
  };
  const first = makeVideo("one", 700), second = makeVideo("two", 1900);
  const middle = element("p", "两段视频之间继续阅读的教材文字".repeat(90)); middle.offsetTop = 1000;
  const tail = element("p", "第二段视频之后仍需阅读的教材尾文".repeat(90)); tail.offsetTop = 2300;
  append(body, [firstText, first.row, middle, second.row, tail]);
  append(chapterBox, [tiny, body]); append(host, [chapterBox]); append(engine.main, [host]); append(shell, [engine.main]); append(root, [shell, engine.catalog, engine.next]);
  const nodes = [root, ...descendants(root)];
  const simple = (node, selector) => {
    if (!/^(?:[a-z][\w-]*)?(?:[.#][\w-]+)*$/i.test(selector) || !selector) return false;
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    const id = selector.match(/#([\w-]+)/)?.[1];
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    return (!tag || node.tagName.toLowerCase() === tag.toLowerCase()) && (!id || node.getAttribute("id") === id) &&
      classes.every(name => node.className.split(/\s+/).includes(name));
  };
  for (const node of nodes) {
    node.ownerDocument = engine.context.document;
    const originalMatches = node.matches.bind(node), originalClosest = node.closest.bind(node), originalQueries = node.querySelectorAll.bind(node);
    node.matches = selector => selector.split(",").some(part => simple(node, part.trim())) || originalMatches(selector);
    node.closest = selector => { for (let parent = node; parent; parent = parent.parentElement) if (parent.matches(selector)) return parent; return originalClosest(selector); };
    node.querySelectorAll = selector => selector === "*" ? descendants(node) :
      [...new Set([...originalQueries(selector), ...descendants(node).filter(item => item.matches(selector))])];
  }
  engine.mappings.delete(".reader-content");
  engine.mappings.set("*", nodes);
  engine.mappings.set(".reader-mobile__body #reader-container .reader-chapter-content.w-e-text", [tiny, body]);
  engine.mappings.set(".reader-mobile__body #reader-container", [host]);
  engine.mappings.set("video", [first.media, second.media]);
  return { engine, root, shell, host, tiny, body, first, second };
}

async function until(engine, condition, seconds = 90) {
  for (let step = 0; step < seconds && !condition(); step++) await engine.clock.advance(1000);
  assert.ok(condition(), "the expected textbook state was not reached");
}

test("verified textbook scrolling uses reader-container and never the small hidden-overflow chapter text", async () => {
  const { engine, root, shell, host, tiny, first, second } = textbook();
  engine.mappings.set("video", []);
  host.scrollTop = 404;
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(host.scrollTop, 0);
  assert.equal(root.scrollTop, 180);
  await engine.clock.advance(4000);
  assert.ok(host.scrollTop > 0);
  assert.equal(tiny.scrollTop, 0, "82px text with 105px overflow is not the textbook scroll component");
  assert.equal(shell.scrollTop, 0);
  assert.equal(root.scrollTop, 180);
  assert.equal(first.input.checked, false);
  assert.equal(second.input.checked, false);
});

test("collapsed textbook videos open one at a time only after their titles are reached, then play at the reader center", async () => {
  const { engine, root, shell, host, tiny, first, second } = textbook();
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  await engine.clock.advance(899);
  assert.equal(first.input.clicks, 0);
  assert.equal(first.media.playCalls, 0, "a real zero-height clipping wrapper continues to block playback");
  assert.equal(second.input.clicks, 0);
  await until(engine, () => first.input.checked);
  const firstTitle = first.title.getBoundingClientRect(), reader = host.getBoundingClientRect();
  assert.ok(Math.abs(firstTitle.top + firstTitle.height / 2 - (reader.top + reader.height / 2)) <= 63);
  assert.equal(first.media.playCalls, 0, "opening the title waits for the next reading step before playback");
  assert.equal(second.input.checked, false, "later videos remain folded");
  await until(engine, () => first.media.playCalls === 1);
  const firstRect = first.media.getBoundingClientRect();
  assert.ok(Math.abs(firstRect.top + firstRect.height / 2 - (reader.top + reader.height / 2)) <= 63);
  assert.equal(first.input.clicks, 1);
  assert.equal(second.input.checked, false);
  const playbackPosition = host.scrollTop;
  await engine.clock.advance(5000);
  assert.equal(host.scrollTop, playbackPosition);
  first.media.finish();
  await until(engine, () => second.media.playCalls === 1);
  assert.equal(second.input.clicks, 1);
  assert.ok(host.scrollTop > playbackPosition, "the intervening text is read before reaching the second video");
  assert.equal(first.media.playCalls, 1);
  second.media.finish();
  await until(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight);
  assert.equal(engine.snapshot().flow.videosCompleted, 2);
  assert.equal(tiny.scrollTop, 0);
  assert.equal(shell.scrollTop, 0);
  assert.equal(root.scrollTop, 180);
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_DONE"), false);
});

test("resume waits at an already checked textbook disclosure whose player is still collapsed", async () => {
  const { engine, root, host, first, second } = textbook();
  first.input.click = () => { first.input.clicks += 1; first.input.checked = true; };
  await engine.ask("ENGINE_RUN", { settings, resetPosition: true, runId: "collapsed-first" });
  await until(engine, () => first.input.checked);
  await engine.clock.advance(5000);
  assert.equal(engine.snapshot().phase, "blocked");
  assert.equal(first.wrapper.clientHeight, 0);
  const blockedPosition = host.scrollTop;
  const paused = await engine.ask("ENGINE_PAUSE");
  await engine.ask("ENGINE_STOP");
  await engine.ask("ENGINE_RUN", { settings, resetPosition: false, checkpoint: paused.snapshot, runId: "collapsed-resumed" });
  assert.equal(host.scrollTop, blockedPosition);
  await engine.clock.advance(15000);
  assert.equal(engine.snapshot().phase, "blocked");
  assert.match(engine.snapshot().detail, /未能展开/);
  assert.equal(host.scrollTop, blockedPosition, "resume cannot scroll past a disclosure still waiting for its real player");
  assert.equal(first.input.clicks, 1, "resume must not toggle an already checked disclosure closed");
  assert.equal(first.media.playCalls, 0);
  assert.equal(second.input.clicks, 0);
  assert.equal(root.scrollTop, 180);
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_DONE"), false);
});
