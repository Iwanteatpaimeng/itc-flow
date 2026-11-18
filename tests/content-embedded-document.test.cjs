"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
const append = (parent, children) => { parent.children = children; children.forEach(node => { node.parentElement = parent; }); };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const lastEmbeddedSnapshot = engine => engine.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS").at(-1)?.snapshot;

function installTreeQueries(engine) {
  const root = engine.context.document.scrollingElement;
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
  for (const node of [root, ...descendants(root)]) {
    node.ownerDocument = engine.context.document;
    node.matches = selector => matches(node, selector);
    node.closest = selector => { for (let current = node; current; current = current.parentElement) if (matches(current, selector)) return current; return null; };
    node.querySelectorAll = selector => descendants(node).filter(item => selector === "*" || matches(item, selector));
  }
  engine.context.document.querySelectorAll = selector => [root, ...descendants(root)].filter(node => selector === "*" || matches(node, selector));
}

// Keep the host/chapter/insertH5 structure from the supplied Edge diagnosis.
// The Word document has its own content engine and its own scrolling element;
// no parent contentDocument access is supplied, as in a cross-origin embed.
function fixture({ forwardChildProgress = true } = {}) {
  const owner = createContent();
  const child = createContent({ type: "document", title: "本地 Word 阅读器" });
  const root = owner.context.document.scrollingElement;
  Object.assign(root, { clientHeight: 935, scrollHeight: 1384, scrollTop: 149 });
  owner.context.innerHeight = 935;
  owner.main.className = "reader-web";
  owner.main.offsetTop = 149;
  const host = element("div", "", { id: "reader-container" });
  host.className = "reader-container";
  Object.assign(host, { offsetTop: 56, clientHeight: 664, scrollHeight: 2600 });
  host.style.overflowY = "auto";
  const chapterBox = element("div", "", { id: "reader-chapter-box" });
  Object.assign(chapterBox, { clientHeight: 2515, scrollHeight: 2515 });
  const chapter = element("div", "Word 前后的教材文字。".repeat(150), { id: "chapter-with-word" });
  chapter.className = "reader-chapter-content w-e-text";
  Object.assign(chapter, { clientHeight: 2350, scrollHeight: 2350 });
  const intro = element("p", "Word 前面的教材文字，必须逐段向下阅读。".repeat(50));
  Object.assign(intro, { clientHeight: 900, scrollHeight: 900 });
  const frame = element("iframe", "", { id: "word-embed", src: "https://dbook.hep.com.cn/local-word-reader" });
  frame.className = "insertH5 cres";
  Object.assign(frame, { offsetTop: 900, clientHeight: 600, scrollHeight: 600, contentWindow: child.context });
  const tail = element("p", "Word 读完后继续阅读这一段教材尾文。".repeat(100));
  Object.assign(tail, { offsetTop: 1570, clientHeight: 700, scrollHeight: 700 });
  append(root, [owner.main]); append(owner.main, [host]); append(host, [chapterBox]); append(chapterBox, [chapter]); append(chapter, [intro, frame, tail]);
  installTreeQueries(owner);
  owner.context.document.title = "教材里的 Word 文档";
  Object.assign(child.context.document.scrollingElement, { clientHeight: 600, scrollHeight: 600 });
  child.context.innerHeight = 600;
  Object.assign(child.reader, { clientHeight: 430, scrollHeight: 1900 });
  child.main.children = [child.reader];
  child.context.location = new URL("https://dbook.hep.com.cn/local-word-reader");
  child.context.parent = owner.context;
  child.context.top = owner.context;
  const actualChildPost = message => child.emitWindow("message", { data: message, source: owner.context });
  // The parent posts only through the real child window. The reply routing below
  // mirrors background.js and preserves the generated pairing tokens.
  child.context.postMessage = actualChildPost;
  let ownerIndex = 0, childIndex = 0, pending = null, ready = null;
  const route = async () => {
    for (let pass = 0; pass < 6; pass++) {
      let progressed = false;
      while (ownerIndex < owner.outbound.length) {
        progressed = true;
        const message = owner.outbound[ownerIndex++];
        if (message.type === "ENGINE_EMBEDDED_REQUEST") pending = message;
      }
      while (childIndex < child.outbound.length) {
        progressed = true;
        const message = child.outbound[childIndex++];
        if (message.type === "ENGINE_EMBEDDED_READY") ready = message;
        else if (message.type === "ENGINE_EMBEDDED_PROGRESS" && forwardChildProgress) await owner.ask("ENGINE_EMBEDDED_STATUS", { token: message.token, runId: message.runId, snapshot: message.snapshot });
        else if (message.type === "ENGINE_EMBEDDED_DONE") await owner.ask("ENGINE_EMBEDDED_RETURN", { token: message.token, runId: message.runId, snapshot: message.snapshot, ok: true });
      }
      if (pending && ready?.token === pending.token) {
        const request = pending; pending = null; ready = null;
        const started = await child.ask("ENGINE_EMBEDDED_RUN", { token: request.token, settings, runId: request.runId, resetPosition: request.resetPosition });
        assert.equal(started.ok, true, "the Word engine accepts its actual parent's pairing token");
        progressed = true;
      }
      if (!progressed) return;
    }
  };
  const advance = async milliseconds => {
    for (let step = 0; step < milliseconds; step += 100) {
      await owner.clock.advance(Math.min(100, milliseconds - step));
      await child.clock.advance(Math.min(100, milliseconds - step));
      await route();
    }
  };
  const until = async condition => {
    for (let step = 0; step < 600 && !condition(); step++) await advance(100);
    assert.ok(condition(), `condition not reached: ${owner.snapshot()?.phase} / ${owner.snapshot()?.detail}`);
  };
  return { owner, child, root, host, frame, chapter, tail, advance, until, route };
}

test("textbook text hands off to the nested Word reader, then resumes trailing text without restarting", async () => {
  const state = fixture();
  const { owner, child, root, host, until, advance } = state;
  const started = await owner.ask("ENGINE_RUN", { settings, runId: "text-word-text", resetPosition: true });
  assert.equal(started.ok, true);
  assert.equal(host.scrollTop, 0);
  await advance(1800);
  assert.ok(host.scrollTop > 0, "the text before Word is read first");
  assert.equal(child.reader.scrollTop, 0, "Word cannot scroll before the textbook reaches it");
  await until(() => child.reader.scrollTop > 0);
  const heldPosition = host.scrollTop;
  const request = owner.outbound.find(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.ok(request);
  await advance(3500);
  assert.equal(host.scrollTop, heldPosition, "textbook position stays fixed while the inner Word document scrolls");
  assert.ok(child.reader.scrollTop > 0);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  assert.equal(child.reader.scrollTop, child.reader.scrollHeight - child.reader.clientHeight);
  await until(() => host.scrollTop > heldPosition);
  await until(() => owner.snapshot()?.phase === "waiting_completion");
  assert.equal(host.scrollTop, host.scrollHeight - host.clientHeight, "the tail text is read after the Word document");
  assert.equal(owner.snapshot().runId, "text-word-text");
  assert.equal(owner.snapshot().key, started.candidate.key);
  assert.equal(root.scrollTop, 149, "the outer webpage position remains unchanged");
  assert.equal(owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length, 1);
});

test("recognizing the reached Word iframe as a document preserves its textbook identity and scroll host", async () => {
  const { owner, host, advance, until } = fixture();
  const started = await owner.ask("ENGINE_RUN", { settings, runId: "document-recognition", resetPosition: true });
  await until(() => owner.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"));
  const position = host.scrollTop;
  const changed = await owner.ask("ENGINE_PROBE", { settings: { ...settings, selectors: { document: "#word-embed" } } });
  assert.equal(changed.candidate.type, "document");
  assert.equal(changed.candidate.key, started.candidate.key, "switching from text to the contained Word frame is one textbook task");
  assert.equal(changed.diagnostics.scroll.target.viewportHeight, 664);
  assert.equal(changed.diagnostics.scroll.target.contentHeight, 2600);
  assert.equal(host.scrollTop, position, "probing a Word iframe must not reset the outer textbook");
  owner.mutate();
  await advance(700);
  assert.equal(owner.snapshot().runId, "document-recognition");
  assert.equal(owner.outbound.some(message => message.type === "ENGINE_CHANGED" && message.elementReplaced), false);
});

test("pause and resume preserve the nested Word position and a late old return cannot end its new binding", async () => {
  const { owner, child, root, host, until, advance } = fixture();
  await owner.ask("ENGINE_RUN", { settings, runId: "word-pause-first", resetPosition: true });
  await until(() => child.reader.scrollTop > 0);
  const oldRequest = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").at(-1);
  const ownerPaused = await owner.ask("ENGINE_PAUSE");
  await child.ask("ENGINE_PAUSE");
  const wordPosition = child.reader.scrollTop, textbookPosition = host.scrollTop;
  await advance(4000);
  assert.equal(child.reader.scrollTop, wordPosition);
  assert.equal(host.scrollTop, textbookPosition);
  await owner.ask("ENGINE_STOP"); await child.ask("ENGINE_STOP");
  await owner.ask("ENGINE_RUN", { settings, checkpoint: ownerPaused.snapshot, runId: "word-pause-resumed", resetPosition: false });
  await advance(1500);
  assert.ok(child.reader.scrollTop >= wordPosition, "continuing the same embed cannot reset the Word reader");
  assert.equal(host.scrollTop, textbookPosition);
  const newRequest = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").at(-1);
  assert.notEqual(newRequest.token, oldRequest.token);
  await owner.ask("ENGINE_EMBEDDED_RETURN", { token: oldRequest.token, runId: oldRequest.runId, ok: true });
  await advance(500);
  assert.equal(host.scrollTop, textbookPosition, "late completion from the paused binding cannot resume textbook text early");
  await until(() => host.scrollTop > textbookPosition);
  assert.equal(root.scrollTop, 149);
});

test("restarting the textbook resets a previously partially read Word document only when it is reached again", async () => {
  const { owner, child, host, until, advance } = fixture();
  await owner.ask("ENGINE_RUN", { settings, runId: "word-before-restart", resetPosition: true });
  await until(() => child.reader.scrollTop > 0);
  const previousPosition = child.reader.scrollTop;
  await owner.ask("ENGINE_STOP"); await child.ask("ENGINE_STOP");
  await owner.ask("ENGINE_RUN", { settings, runId: "word-after-restart", resetPosition: true });
  assert.equal(host.scrollTop, 0);
  assert.equal(child.reader.scrollTop, previousPosition, "do not scroll or reset an offscreen Word iframe during the outer restart");
  const requests = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length;
  await until(() => owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length > requests);
  const latest = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").at(-1);
  assert.equal(latest.resetPosition, true);
  assert.equal(child.reader.scrollTop, 0, "the fresh delegated Word run begins at its own top");
  await advance(2000);
  assert.ok(child.reader.scrollTop > 0);
});

test("resuming before the first Word status preserves pending embed identity and both reading positions", async () => {
  // The Word engine may already be reading while its first status is still in
  // transit. Pause must record which iframe is active even without that status.
  const { owner, child, root, host, until, route } = fixture({ forwardChildProgress: false });
  await owner.ask("ENGINE_RUN", { settings, runId: "word-pending-before-pause", resetPosition: true });
  await until(() => child.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS").at(-1)?.snapshot.scroll.movements > 0);
  assert.equal(owner.snapshot().flow.embeddedActive, true);
  const ownerPaused = await owner.ask("ENGINE_PAUSE");
  const childPaused = await child.ask("ENGINE_PAUSE");
  const textbookPosition = host.scrollTop, wordPosition = child.reader.scrollTop;
  assert.ok(textbookPosition > 0);
  assert.ok(ownerPaused.snapshot.scroll.movements > 0);
  assert.ok(ownerPaused.snapshot.elapsedSeconds > 0);
  assert.ok(childPaused.snapshot.scroll.movements > 0);
  await owner.ask("ENGINE_STOP"); await child.ask("ENGINE_STOP");
  const requests = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length;
  const resumed = await owner.ask("ENGINE_RUN", {
    settings, checkpoint: ownerPaused.snapshot, runId: "word-pending-after-pause", resetPosition: false
  });
  assert.equal(resumed.ok, true);
  await route();
  const allRequests = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.equal(allRequests.length, requests + 1, "resume reconnects the same reached Word iframe");
  assert.equal(allRequests.at(-1).resetPosition, false, "missing first status must not turn Continue into Restart for Word");
  assert.equal(host.scrollTop, textbookPosition, "textbook reading position is preserved");
  assert.equal(resumed.snapshot.scroll.movements, ownerPaused.snapshot.scroll.movements);
  assert.equal(resumed.snapshot.elapsedSeconds, ownerPaused.snapshot.elapsedSeconds);
  assert.equal(child.reader.scrollTop, wordPosition, "the nested Word reader resumes its own checkpoint");
  const childState = child.outbound.filter(message => message.type === "ENGINE_EMBEDDED_PROGRESS").at(-1).snapshot;
  assert.equal(childState.scroll.movements, childPaused.snapshot.scroll.movements);
  assert.equal(childState.elapsedSeconds, childPaused.snapshot.elapsedSeconds);
  assert.equal(root.scrollTop, 149);
});

test("a bound Word loading placeholder waits for document pages before scrolling and completing", async () => {
  const { owner, child, host, until, advance } = fixture();
  child.reader.className = "document-viewer";
  child.reader.innerText = child.reader.textContent = "";
  child.reader.scrollHeight = child.reader.clientHeight;
  const loading = element("div", "正在加载文档");
  loading.className = "loading";
  append(child.reader, [loading]);
  installTreeQueries(child);
  await owner.ask("ENGINE_RUN", { settings, runId: "word-loading", resetPosition: true });
  await until(() => lastEmbeddedSnapshot(child)?.scroll.state === "loading_document");
  const heldPosition = host.scrollTop;
  assert.equal(lastEmbeddedSnapshot(child).phase, "waiting");
  await advance(5000);
  assert.equal(lastEmbeddedSnapshot(child).scroll.state, "loading_document");
  assert.equal(child.reader.scrollTop, 0);
  assert.equal(host.scrollTop, heldPosition);
  assert.equal(child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false, "an empty loading viewer is not a completed Word document");

  loading.hidden = true;
  child.reader.innerText = child.reader.textContent = "加载完成的 Word 正文内容。".repeat(100);
  child.reader.scrollHeight = 1900;
  child.mutate();
  await until(() => child.reader.scrollTop > 0);
  assert.equal(child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false, "the loaded pages must be read before completion");
  assert.equal(host.scrollTop, heldPosition);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  assert.equal(child.reader.scrollTop, child.reader.scrollHeight - child.reader.clientHeight);
  await until(() => host.scrollTop > heldPosition);
});

test("a canvas-only custom Word scroll div is recognized only after its actual parent binds it", async () => {
  const { owner, child, host, until } = fixture();
  child.reader.tagName = "DIV";
  child.reader.className = "office-page-scroll";
  child.reader.innerText = child.reader.textContent = "";
  const page = element("canvas");
  Object.assign(page, { clientHeight: 1400, scrollHeight: 1400 });
  append(child.reader, [page]);
  installTreeQueries(child);
  const unbound = await child.ask("ENGINE_PROBE", { settings });
  assert.equal(unbound.candidate, null, "a random canvas container on an unbound website is not a document task");
  const started = await owner.ask("ENGINE_RUN", { settings, runId: "word-canvas", resetPosition: true });
  await until(() => lastEmbeddedSnapshot(child)?.taskType === "document");
  const heldPosition = host.scrollTop;
  const bound = await child.ask("ENGINE_PROBE", { settings });
  assert.equal(bound.candidate.type, "document");
  assert.equal(bound.diagnostics.scroll.target.viewportHeight, 430);
  assert.equal(bound.diagnostics.scroll.target.contentHeight, 1900);
  await until(() => child.reader.scrollTop > 0);
  assert.equal(host.scrollTop, heldPosition);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  assert.equal(child.reader.scrollTop, 1470, "the independent canvas reader reaches its own bottom");
  assert.equal(child.context.document.scrollingElement.scrollTop, 0);
  await until(() => host.scrollTop > heldPosition);
  assert.equal(owner.snapshot().key, started.candidate.key);
  assert.equal(owner.snapshot().runId, "word-canvas");
});

test("Word iframe load reconnects with a fresh token and preserves the surrounding textbook run", async () => {
  const { owner, child, root, host, frame, until, route, advance } = fixture();
  const started = await owner.ask("ENGINE_RUN", { settings, runId: "word-iframe-reload", resetPosition: true });
  await until(() => lastEmbeddedSnapshot(child)?.scroll.movements > 0);
  const previous = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").at(-1);
  const heldPosition = host.scrollTop;
  const wordPosition = child.reader.scrollTop;
  frame.emit("load");
  const reconnected = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").at(-1);
  assert.notEqual(reconnected.token, previous.token);
  assert.equal(reconnected.resetPosition, false, "iframe navigation reconnects the active segment without restarting it");
  assert.equal(reconnected.key, started.candidate.key);
  assert.equal(reconnected.runId, "word-iframe-reload");
  await route();
  assert.equal(host.scrollTop, heldPosition);
  assert.equal(child.reader.scrollTop, wordPosition);
  await owner.ask("ENGINE_EMBEDDED_RETURN", { token: previous.token, runId: previous.runId, ok: true });
  await advance(500);
  assert.equal(host.scrollTop, heldPosition, "the old iframe cannot release the new Word binding");
  assert.equal(owner.snapshot().flow.embeddedActive, true);
  assert.equal(owner.snapshot().key, started.candidate.key);
  assert.equal(owner.snapshot().runId, "word-iframe-reload");
  assert.equal(root.scrollTop, 149);
  await until(() => host.scrollTop > heldPosition);
});

test("a busy Word viewer root waits instead of completing its long loading message", async () => {
  for (const marker of ["aria-busy", "loading-class"]) {
    const child = createContent({ type: "document" });
    child.main.tagName = "DIV";
    child.reader.scrollHeight = child.reader.clientHeight;
    child.reader.innerText = child.reader.textContent = "正在加载文档内容，请稍候。".repeat(8);
    child.reader.className = marker === "loading-class" ? "document-viewer loading" : "document-viewer";
    if (marker === "aria-busy") child.reader.setAttribute("aria-busy", "true");
    const originalMatches = child.reader.matches.bind(child.reader);
    child.reader.matches = selector => originalMatches(selector) || selector.split(",").some(part =>
      part.trim() === "[aria-busy='true']" && child.reader.getAttribute("aria-busy") === "true" ||
      part.trim() === ".loading" && child.reader.className.split(/\s+/).includes("loading"));
    const parent = {};
    child.context.parent = child.context.top = parent;
    const token = `busy-root-${marker}`;
    child.emitWindow("message", { source: parent, data: { protocol: "itc-flow-viewport-v1", kind: "flow-bind", token } });
    const result = await child.ask("ENGINE_EMBEDDED_RUN", { token, runId: "busy-root", resetPosition: true, settings });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.scroll.state, "loading_document", `${marker} on the viewer itself must be checked`);
    await child.clock.advance(3000);
    assert.equal(child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false, "a loading message is not the Word document");
    child.reader.setAttribute("aria-busy", "false");
    child.reader.className = "document-viewer";
    child.reader.innerText = child.reader.textContent = "加载完成后的真实文档正文。".repeat(100);
    child.reader.scrollHeight = 1900;
    child.mutate();
    await child.clock.advance(3500);
    assert.ok(child.reader.scrollTop > 0, "loaded Word pages resume timed internal scrolling");
    assert.equal(child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false);
  }
});

test("replacing the active Word viewer keeps its bound reading flow alive without restarting the textbook", async () => {
  const { owner, child, host, until, advance } = fixture();
  child.reader.className = "document-viewer";
  installTreeQueries(child);
  const started = await owner.ask("ENGINE_RUN", { settings, runId: "replace-word-viewer", resetPosition: true });
  await until(() => child.reader.scrollTop > 0);
  const oldReader = child.reader;
  const previousPosition = oldReader.scrollTop;
  const previousSnapshot = lastEmbeddedSnapshot(child);
  const textbookPosition = host.scrollTop;
  const requestCount = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length;
  const replacement = element("article", "重新渲染后的 Word 正文。".repeat(100));
  replacement.className = "document-viewer";
  replacement.style.overflowY = "auto";
  Object.assign(replacement, { clientHeight: 430, scrollHeight: 1900, scrollTop: previousPosition });
  oldReader.isConnected = false;
  append(child.main, [replacement]);
  installTreeQueries(child);
  child.mutate();
  await advance(4500);
  assert.ok(replacement.scrollTop > previousPosition, "the replacement Word viewer must continue its timed internal scrolling");
  assert.equal(host.scrollTop, textbookPosition, "a document render cannot release or restart its surrounding textbook");
  assert.equal(lastEmbeddedSnapshot(child).runId, "replace-word-viewer");
  assert.equal(lastEmbeddedSnapshot(child).key, previousSnapshot.key);
  assert.ok(lastEmbeddedSnapshot(child).scroll.movements > previousSnapshot.scroll.movements);
  assert.equal(owner.snapshot().key, started.candidate.key);
  assert.equal(owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length, requestCount);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  assert.equal(replacement.scrollTop, 1470);
  await until(() => host.scrollTop > textbookPosition);
});

test("a temporary empty Word shell retains the binding until its replacement pages arrive", async () => {
  const { owner, child, host, until, advance } = fixture();
  child.reader.className = "document-viewer";
  installTreeQueries(child);
  await owner.ask("ENGINE_RUN", { settings, runId: "word-empty-render", resetPosition: true });
  await until(() => child.reader.scrollTop > 0);
  const position = child.reader.scrollTop, textbookPosition = host.scrollTop;
  const oldKey = lastEmbeddedSnapshot(child).key;
  child.reader.isConnected = false;
  append(child.main, []);
  installTreeQueries(child);
  child.mutate();
  await advance(4000);
  assert.equal(lastEmbeddedSnapshot(child).scroll.state, "loading_document");
  assert.equal(lastEmbeddedSnapshot(child).key, oldKey);
  assert.equal(child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"), false);
  assert.equal(host.scrollTop, textbookPosition);
  const replacement = element("article", "加载回来的 Word 正文。".repeat(100));
  replacement.className = "document-viewer";
  replacement.style.overflowY = "auto";
  Object.assign(replacement, { clientHeight: 430, scrollHeight: 1900, scrollTop: position });
  append(child.main, [replacement]);
  installTreeQueries(child);
  child.mutate();
  await advance(650);
  assert.equal(replacement.scrollTop, position, "a temporary shell cannot overwrite the saved Word reading position");
  await until(() => replacement.scrollTop > position);
  assert.equal(lastEmbeddedSnapshot(child).runId, "word-empty-render");
  assert.equal(lastEmbeddedSnapshot(child).key, oldKey);
  assert.equal(host.scrollTop, textbookPosition);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  await until(() => host.scrollTop > textbookPosition);
});

test("a bound canvas Word renderer can become text without changing its identity or restarting the textbook", async () => {
  const { owner, child, host, root, until, advance } = fixture();
  child.reader.tagName = "DIV";
  child.reader.className = "office-page-scroll";
  child.reader.innerText = child.reader.textContent = "";
  const page = element("canvas");
  Object.assign(page, { clientWidth: 700, clientHeight: 1400, scrollHeight: 1400 });
  append(child.reader, [page]);
  installTreeQueries(child);
  const started = await owner.ask("ENGINE_RUN", { settings, runId: "word-canvas-to-text", resetPosition: true });
  await until(() => child.reader.scrollTop > 0);
  const before = lastEmbeddedSnapshot(child), position = child.reader.scrollTop, textbookPosition = host.scrollTop;
  const requestCount = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length;
  child.reader.className = "reader-content";
  child.reader.innerText = child.reader.textContent = "Word 已加载可访问的正文段落。".repeat(100);
  append(child.reader, [element("p", child.reader.innerText)]);
  installTreeQueries(child);
  child.mutate();
  await advance(3500);
  assert.ok(child.reader.scrollTop > position, "rendering accessible text cannot stop the bound Word flow");
  const after = lastEmbeddedSnapshot(child);
  assert.equal(after.key, before.key);
  assert.equal(after.runId, before.runId);
  assert.ok(after.scroll.movements > before.scroll.movements);
  assert.equal(host.scrollTop, textbookPosition);
  assert.equal(owner.snapshot().key, started.candidate.key);
  assert.equal(owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length, requestCount);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  assert.equal(child.reader.scrollTop, 1470);
  await until(() => host.scrollTop > textbookPosition);
  assert.equal(root.scrollTop, 149);
});

test("a bound text Word renderer can become a document viewer without losing its active reading flow", async () => {
  const { owner, child, host, until, advance } = fixture();
  child.reader.tagName = "DIV";
  child.reader.className = "reader-content";
  installTreeQueries(child);
  await owner.ask("ENGINE_RUN", { settings, runId: "word-text-to-document", resetPosition: true });
  await until(() => child.reader.scrollTop > 0);
  const before = lastEmbeddedSnapshot(child), position = child.reader.scrollTop, textbookPosition = host.scrollTop;
  const requestCount = owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length;
  child.reader.className = "document-viewer";
  child.mutate();
  await advance(3500);
  assert.ok(child.reader.scrollTop > position, "changing the viewer's recognizable type cannot retire its live delegation");
  const after = lastEmbeddedSnapshot(child);
  assert.equal(after.key, before.key);
  assert.equal(after.runId, before.runId);
  assert.ok(after.scroll.movements > before.scroll.movements);
  assert.equal(host.scrollTop, textbookPosition);
  assert.equal(owner.outbound.filter(message => message.type === "ENGINE_EMBEDDED_REQUEST").length, requestCount);
  await until(() => child.outbound.some(message => message.type === "ENGINE_EMBEDDED_DONE"));
  assert.equal(child.reader.scrollTop, 1470);
  await until(() => host.scrollTop > textbookPosition);
});
