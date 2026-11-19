"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element, mediaElement } = require("./helpers/content-harness.cjs");

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const append = (parent, children) => { parent.children = children; children.forEach(child => { child.parentElement = parent; }); };
const settings = { scrollIntervalSeconds: 1, scrollEnabled: true, readingSpeed: "standard" };

// The page shell shared by the desktop textbook fixtures: no main/mobile reader,
// two nested application wrappers and a native reader-container.
function readerShell({ hostScrollHeight = 5640, chaptersHeight = 5560 } = {}) {
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
  Object.assign(host, { clientHeight: 664, scrollHeight: hostScrollHeight }); host.style.overflowY = "auto";
  const chapters = element("div", "", { id: "reader-chapter-box" });
  Object.assign(chapters, { clientHeight: chaptersHeight, scrollHeight: chaptersHeight });
  return { engine, root, body, app, appWrapper, readerBox, custom, web, webInner, outer, right, wrapper, host, chapters };
}

// Attach the built tree to the engine document and teach the DOM double the
// compound selectors content.js uses.
function attachTree(shell, title) {
  const { engine, root, body, app, appWrapper, readerBox, custom, web, webInner, outer, right, wrapper, host, chapters } = shell;
  append(host, [chapters]); append(wrapper, [host]); append(right, [wrapper]); append(outer, [right]);
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
  engine.context.document.title = title;
  engine.context.document.body = body;
  engine.context.document.querySelectorAll = selector => {
    if (selector === "[") throw new SyntaxError("Invalid selector");
    return nodes.filter(node => selector === "*" || matches(node, selector));
  };
  engine.mappings.clear();
  return shell;
}

// Reproduce the supplied desktop diagnosis: a reader whose chapters live inside
// one scroller, folded players and delegated Word frames.
function desktopTextbook({ expansionDelay = 0, withVideos = true, secondChapter = false } = {}) {
  const shell = readerShell();
  const { engine, root, body, wrapper, host, chapters } = shell;
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
  const chapterTwo = secondChapter ? element("div", "第二章的教材正文需要继续逐段阅读。".repeat(300), { id: "chapter-two" }) : null;
  if (chapterTwo) {
    chapterTwo.className = "reader-chapter-content w-e-text";
    Object.assign(chapterTwo, { offsetTop: 5476, clientHeight: 1164, scrollHeight: 1164 });
    Object.assign(chapters, { clientHeight: 6640, scrollHeight: 6640 });
    host.scrollHeight = 6640;
  }
  append(chapters, chapterTwo ? [chapter, chapterTwo] : [chapter]);
  attachTree(shell, "桌面数字教材验证");
  return { engine, root, body, app: shell.app, appWrapper: shell.appWrapper, wrapper, host, chapters, chapter, chapterTwo, first, second };
}

async function until(engine, condition, seconds = 90) {
  for (let step = 0; step < seconds && !condition(); step++) await engine.clock.advance(1000);
  assert.ok(condition(), `expected desktop state was not reached: ${engine.snapshot()?.phase} / ${engine.snapshot()?.detail}`);
}

// The reader geometry reported by the learner: one scroller of 2131px, a 1256px
// chapter whose player sits at 258px, and a second chapter of 760px.
function sessionReader({ withVideo = true } = {}) {
  const shell = readerShell({ hostScrollHeight: 2131, chaptersHeight: 2046 });
  const { engine, host, chapters } = shell;
  const first = element("div", "本章的教材文字较少，主要内容在内嵌文档中。", { id: "FK6H2XH982" });
  first.className = "reader-chapter-content w-e-text";
  Object.assign(first, { clientHeight: 1256, scrollHeight: 1256 });
  const intro = element("p", "章节开头的教材文字".repeat(20)); intro.clientHeight = intro.scrollHeight = 240;
  const paragraph = element("p", "", { id: "p_FK6HX982_1" });
  Object.assign(paragraph, { offsetTop: 258, clientHeight: 414, scrollHeight: 414 });
  const row = element("span", "", { id: "video_td_span_F3CUWCWKKC" }); row.className = "td";
  Object.assign(row, { clientHeight: 414, scrollHeight: 414 });
  const input = element("input", "", { id: "check_F3CUWCWKKC", type: "checkbox" }); input.className = "insertVideoCheck"; input.checked = true;
  const clip = element("span"); clip.className = "element-new";
  Object.assign(clip, { offsetTop: 50, clientHeight: 364, scrollHeight: 364 });
  const media = mediaElement({ id: "F3CUWCWKKC", src: "https://dbook.hep.com.cn/api/v2/resource/preview?id=F3CUWCWKKC" });
  media.className = "insertVideo cres"; media.duration = 655.4;
  media.clientHeight = media.scrollHeight = 355;
  append(clip, [media]); append(row, [input, clip]); append(paragraph, [row]);
  const second = element("div", "第二章的教材正文需要继续逐段阅读。".repeat(120), { id: "F38XUH9D2" });
  second.className = "reader-chapter-content w-e-text";
  Object.assign(second, { offsetTop: 1286, clientHeight: 760, scrollHeight: 760 });
  append(first, withVideo ? [intro, paragraph] : [intro]);
  append(chapters, [first, second]);
  attachTree(shell, "课程阅读器");
  return { engine, host, chapters, first, second, paragraph, input, clip, media };
}

test("the reported learner page plays its textbook video before the chapter end", async () => {
  const { engine, host, media } = sessionReader();
  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(run.ok, true);
  await until(engine, () => media.playCalls === 1, 30);
  media.finish();
  await until(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(engine.snapshot().flow.videosCompleted, 1);
  assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight);
  const probe = await engine.ask("ENGINE_PROBE", { settings });
  const trace = probe.diagnostics.runtime.trace;
  assert.ok(trace.length > 0, "reading decisions are recorded for the copied diagnostic");
  assert.ok(trace.every(entry => typeof entry.action === "string" && entry.action.length > 0));
  assert.ok(trace.some(entry => entry.action === "play"), "the trace names the playback decision");
});

test("the diagnosed long textbook reaches a player that is still below the reading port", async () => {
  // 1.2.12 diagnosis: one scroller of 5961px holding three chapters
  // (4400 + 170 + 1256). The learner stopped at 3965, so the player of the last
  // chapter sits ~250px below the port and has never been played.
  const shell = readerShell({ hostScrollHeight: 5961, chaptersHeight: 5881 });
  const { engine, host, chapters } = shell;
  const long = element("div", "长章节的教材正文需要逐段阅读。".repeat(300), { id: "FKA35H9D2" });
  long.className = "reader-chapter-content w-e-text";
  Object.assign(long, { clientHeight: 4400, scrollHeight: 4400 });
  const bridge = element("div", "过渡小节".repeat(9), { id: "P3ZAL57L82" });
  bridge.className = "reader-chapter-content w-e-text";
  Object.assign(bridge, { offsetTop: 4400, clientHeight: 170, scrollHeight: 170 });
  const last = element("div", "本章的教材文字较少，主要内容在内嵌文档中。", { id: "FK6H2XH982" });
  last.className = "reader-chapter-content w-e-text";
  Object.assign(last, { offsetTop: 4570, clientHeight: 1256, scrollHeight: 1256 });
  const paragraph = element("p", "", { id: "p_FK6HX982_1" });
  Object.assign(paragraph, { offsetTop: 258, clientHeight: 414, scrollHeight: 414 });
  const row = element("span", "", { id: "video_td_span_F3CUWCWKKC" }); row.className = "td";
  Object.assign(row, { clientHeight: 414, scrollHeight: 414 });
  const input = element("input", "", { id: "check_F3CUWCWKKC", type: "checkbox" }); input.className = "insertVideoCheck"; input.checked = true;
  const clip = element("span"); clip.className = "element-new";
  Object.assign(clip, { offsetTop: 50, clientHeight: 364, scrollHeight: 364 });
  const media = mediaElement({ id: "F3CUWCWKKC", src: "https://dbook.hep.com.cn/api/v2/resource/preview?id=F3CUWCWKKC" });
  media.className = "insertVideo cres"; media.duration = 655.4;
  media.clientHeight = media.scrollHeight = 355;
  append(clip, [media]); append(row, [input, clip]); append(paragraph, [row]); append(last, [paragraph]);
  append(chapters, [long, bridge, last]);
  attachTree(shell, "课程阅读器");
  host.scrollTop = 3965;

  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: false });
  assert.equal(run.ok, true);
  await until(engine, () => media.playCalls === 1, 60);
  assert.ok(["video", "playing"].includes(engine.snapshot()?.phase), `unexpected phase ${engine.snapshot()?.phase}`);
  assert.equal(input.checked, true, "the already expanded player is not toggled shut");
  media.finish();
  await until(engine, () => engine.snapshot()?.flow.videosCompleted === 1 && !engine.snapshot()?.flow.embeddedActive, 60);
  const probe = await engine.ask("ENGINE_PROBE", { settings });
  assert.ok(probe.diagnostics.runtime.trace.some(entry => entry.action === "play"));
});

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

test("a chapter the learner already selected is where a textbook restart begins", async () => {
  const { engine, host, first, chapterTwo } = desktopTextbook({ secondChapter: true });
  host.scrollTop = 5800;
  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(run.ok, true);
  assert.ok(host.scrollTop > 5000, "restarting must not rewind to the first chapter of the book");
  const hostTop = host.getBoundingClientRect().top;
  assert.ok(chapterTwo.getBoundingClientRect().top <= hostTop + 24, "the selected chapter starts at the reading port top");
  assert.ok(chapterTwo.getBoundingClientRect().top >= hostTop - 24);
  assert.equal(first.media.playCalls, 0, "a video from an earlier chapter is not replayed");
  await until(engine, () => engine.snapshot()?.phase === "waiting_completion");
  assert.equal(first.media.playCalls, 0, "a passed video never hijacks the selected chapter");
  assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight, "the selected chapter is read to its end");
  assert.equal(engine.snapshot().flow.videosCompleted, 0);
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

test("the last screen of a textbook chapter waits for the reader to post its position", async () => {
  const { engine, host } = sessionReader({ withVideo: false });
  const trace = async () => (await engine.ask("ENGINE_PROBE")).diagnostics.runtime.trace || [];
  const run = await engine.ask("ENGINE_RUN", { settings, resetPosition: true });
  assert.equal(run.ok, true);
  let dwelled = false;
  for (let step = 0; step < 90 && !dwelled; step += 1) {
    await engine.clock.advance(1000);
    dwelled = (await trace()).some(entry => entry.action === "chapter-dwell");
  }
  assert.ok(dwelled, "reaching a chapter end must dwell so the heartbeat can post it");
  const atDwell = host.scrollTop;
  await engine.clock.advance(6000);
  assert.equal(host.scrollTop, atDwell, "the chapter's last screen must stay visible during the dwell");
  await engine.clock.advance(6000);
  assert.ok(host.scrollTop > atDwell, "reading resumes after the dwell");
  const coverage = engine.snapshot()?.flow?.coverage;
  assert.ok(coverage?.chapters?.length >= 1, "diagnostics must list the mounted chapters");
  assert.ok(coverage.chapters.some(chapter => chapter.dwelled), "the settled chapter must be marked as dwelled");
});

test("fast reading jumps to a chapter's last screen instead of crawling every screen", async () => {
  // The platform credits the farthest reported span, so a 5707px chapter with
  // 3959 spans does not need every screen: jump to its last screen, dwell there
  // for the heartbeat, and move on to the next chapter.
  const { engine, host } = sessionReader({ withVideo: false });
  const trace = async () => (await engine.ask("ENGINE_PROBE")).diagnostics.runtime.trace || [];
  const run = await engine.ask("ENGINE_RUN", { settings: { ...settings, readingSpeed: "fast" }, resetPosition: true });
  assert.equal(run.ok, true);
  await engine.clock.advance(1200);
  assert.ok(host.scrollTop > 700, `the first fast step must jump near the chapter end (${host.scrollTop})`);
  assert.ok(host.scrollTop < host.scrollHeight - host.clientHeight, "it must stop at the chapter end, not the book end");
  let dwelled = false;
  for (let step = 0; step < 30 && !dwelled; step += 1) {
    await engine.clock.advance(1000);
    dwelled = (await trace()).some(entry => entry.action === "chapter-dwell");
  }
  assert.ok(dwelled, "the chapter end still waits for the heartbeat after a jump");
});
