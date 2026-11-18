"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element, mediaElement } = require("./helpers/content-harness.cjs");

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const append = (parent, children) => { parent.children = children; children.forEach(child => { child.parentElement = parent; }); };
const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };

// Reproduce the supplied desktop diagnosis: no main/mobile reader, two nested
// application wrappers, visible chapter text and a native reader-container.
function desktopTextbook({ expansionDelay = 0, withVideos = true } = {}) {
  const engine = createContent();
  const root = engine.context.document.scrollingElement;
  const body = element("body", "", { id: "course-html" }); body.className = "reader-body";
  Object.assign(body, { offsetTop: 90, clientHeight: 720, scrollHeight: 720 }); body.style.overflowY = "hidden";
  const app = element("div", "", { id: "app" }), appWrapper = element("div", "", { id: "appWrapper" });
  const readerBox = element("div", "", { id: "readerBox" });
  const custom = element("etextbook-reader-web"); custom.clientHeight = custom.scrollHeight = 0;
  const web = element("div"); web.className = "reader-web";
  const webInner = element("div"); webInner.className = "reader-ehep-web reader-web--bg-white";
  const outer = element("div"); outer.className = "reader-outer";
  const right = element("div"); right.className = "reader-right";
  const wrapper = element("div"); wrapper.className = "reader-wrapper";
  for (const node of [app, appWrapper, readerBox, web, webInner, outer, right, wrapper]) Object.assign(node, { clientHeight: 720, scrollHeight: 720 });
  for (const node of [app, appWrapper, outer, right]) node.style.overflowY = "hidden";
  wrapper.style.overflowY = "auto";
  const host = element("div", "", { id: "reader-container" }); host.className = "reader-container";
  Object.assign(host, { clientHeight: 664, scrollHeight: 5640 }); host.style.overflowY = "auto";
  const chapters = element("div", "", { id: "reader-chapter-box" });
  Object.assign(chapters, { clientHeight: 5560, scrollHeight: 5560 });
  const chapter = element("div", "桌面教材的概念说明需要逐段阅读。".repeat(250)); chapter.className = "reader-chapter-content w-e-text";
  Object.assign(chapter, { clientHeight: 5476, scrollHeight: 5476 });
  const intro = element("p", "视频之前的桌面教材文字".repeat(100)); intro.clientHeight = intro.scrollHeight = 1000;
  const middle = element("p", "两段演示之间的教材内容".repeat(100)); middle.offsetTop = 1500;
  const tail = element("p", "视频后的桌面教材总结".repeat(100)); tail.offsetTop = 3600;
  const makeVideo = (id, offsetTop) => {
    const paragraph = element("p"); Object.assign(paragraph, { offsetTop, clientHeight: 440, scrollHeight: 440 });
    const row = element("span", "", { id: `video_td_span_${id}` }); row.className = "td";
    Object.assign(row, { clientHeight: 440, scrollHeight: 440 });
    const input = element("input", "", { id: `check_${id}`, type: "checkbox" }); input.className = "insertVideoCheck"; input.checked = false;
    const title = element("span", `本地教材视频 ${id}`, { id: `video_title_span_${id}` }); title.className = "videoTitlepc-new";
    title.clientHeight = title.scrollHeight = 50;
    const clip = element("span"); clip.className = "element-new";
    Object.assign(clip, { offsetTop: 50, clientHeight: 0, scrollHeight: 390 }); clip.style.overflowY = clip.style.overflowX = "hidden";
    const media = mediaElement({ id, src: `https://example.test/${id}.mp4` }); media.className = "insertVideo cres";
    media.clientHeight = media.scrollHeight = 381;
    input.click = () => {
      input.clicks++;
      input.checked = !input.checked;
      if (expansionDelay) engine.clock.setTimeout(() => { clip.clientHeight = input.checked ? 390 : 0; engine.mutate(); }, expansionDelay);
      else clip.clientHeight = input.checked ? 390 : 0;
    };
    append(clip, [media]); append(row, [input, title, clip]); append(paragraph, [row]);
    return { paragraph, row, input, title, clip, media };
  };
  const first = makeVideo("desktop-one", 1000), second = makeVideo("desktop-two", 2800);
  append(chapter, withVideos ? [intro, first.paragraph, middle, second.paragraph, tail] : [intro, middle, tail]);
  append(chapters, [chapter]); append(host, [chapters]); append(wrapper, [host]); append(right, [wrapper]); append(outer, [right]);
  append(webInner, [outer]); append(web, [webInner]); append(custom, [web]); append(readerBox, [custom]);
  append(appWrapper, [readerBox]); append(app, [appWrapper]); append(body, [app]); append(root, [body]);
  const nodes = [root, ...descendants(root)];
  const compound = (node, selector) => {
    if (!selector || !/^(?:[a-z][\w-]*)?(?:[.#][\w-]+)*$/i.test(selector)) return false;
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    const id = selector.match(/#([\w-]+)/)?.[1];
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    return (!tag || node.tagName.toLowerCase() === tag.toLowerCase()) && (!id || node.getAttribute("id") === id) && classes.every(value => node.className.split(/\s+/).includes(value));
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
  for (const node of nodes) {
    node.ownerDocument = engine.context.document;
    const originalClosest = node.closest.bind(node), originalMatches = node.matches.bind(node);
    node.matches = selector => matches(node, selector) || originalMatches(selector);
    node.closest = selector => { for (let current = node; current; current = current.parentElement) if (matches(current, selector)) return current; return originalClosest(selector); };
    node.querySelectorAll = selector => descendants(node).filter(child => selector === "*" || matches(child, selector));
  }
  engine.context.document.title = "桌面数字教材验证";
  engine.context.document.body = body;
  engine.context.document.querySelectorAll = selector => {
    if (selector === "[") throw new SyntaxError("Invalid selector");
    return nodes.filter(node => selector === "*" || matches(node, selector));
  };
  engine.mappings.clear();
  return { engine, root, body, app, appWrapper, wrapper, host, chapter, first, second };
}

async function until(engine, condition, seconds = 90) {
  for (let step = 0; step < seconds && !condition(); step++) await engine.clock.advance(1000);
  assert.ok(condition(), `expected desktop state was not reached: ${engine.snapshot()?.phase} / ${engine.snapshot()?.detail}`);
}

test("the diagnosed desktop reader recognizes text without a main or mobile reader element", async () => {
  const { engine, host, body, wrapper } = desktopTextbook({ withVideos: false });
  const probe = await engine.ask("ENGINE_PROBE", { settings });
  assert.equal(probe.candidate?.type, "text");
  assert.ok(probe.diagnostics.textRegionCount > 0);
  host.scrollTop = 2986;
  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(run.ok, true);
  assert.equal(host.scrollTop, 0);
  await engine.clock.advance(4000);
  assert.ok(host.scrollTop > 0);
  assert.equal(body.scrollTop, 0);
  assert.equal(wrapper.scrollTop, 0);
});

test("desktop folded videos retain both surrounding text and later videos in the same reader flow", async () => {
  const { engine, host, root, first, second } = desktopTextbook();
  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(run.ok, true);
  assert.equal(run.candidate.type, "text", "unread text must win over a folded video");
  await until(engine, () => first.media.playCalls === 1);
  assert.equal(first.input.clicks, 1);
  assert.equal(second.input.clicks, 0);
  const playingPosition = host.scrollTop;
  await engine.clock.advance(5000);
  assert.equal(host.scrollTop, playingPosition);
  first.media.finish();
  await until(engine, () => second.media.playCalls === 1);
  assert.ok(host.scrollTop > playingPosition);
  assert.equal(second.input.clicks, 1);
  second.media.finish();
  await until(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(engine.snapshot().flow.videosCompleted, 2);
  assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight);
  assert.equal(root.scrollTop, 0);
  assert.equal(engine.outbound.some(message => message.type === "ENGINE_DONE"), false);
});

test("a desktop disclosure that finishes after the scheduled tick rearms scrolling and its countdown", async () => {
  const { engine, host, first } = desktopTextbook({ expansionDelay: 1800 });
  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(run.ok, true);
  await until(engine, () => first.input.checked);
  const atDisclosure = host.scrollTop;
  await engine.clock.advance(1200);
  assert.equal(first.media.playCalls, 0, "the actual zero-height clip cannot authorize playback");
  await until(engine, () => first.media.playCalls === 1);
  assert.ok(host.scrollTop > atDisclosure, "the player still needs its reading step after expansion");
  const countdowns = engine.outbound.filter(message => message.type === "ENGINE_PROGRESS").map(message => message.snapshot)
    .filter(snapshot => snapshot.elapsedSeconds >= 1 && snapshot.phase === "reading").map(snapshot => snapshot.scroll.nextInSeconds);
  assert.ok(countdowns.some(value => value > 0), "a subsequent reading wait must report its positive countdown");
});
