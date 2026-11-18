"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fakeClock, event } = require("./worker-harness.cjs");

// Small fixture-backed DOM double for lifecycle/timing tests. Browser layout and
// selector integration are intentionally checked with engine-preview.html.
function element(tag, value = "", attributes = {}) {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), innerText: value, textContent: value, attributes: { ...attributes }, className: "", hidden: false, isConnected: true,
    parentElement: null, children: [], queries: new Map(), style: { display: "block", visibility: "visible", opacity: "1", overflowY: "visible" },
    clientWidth: 800, clientHeight: 430, scrollHeight: 430, scrollTop: 0, scrollLeft: 0, offsetTop: 0, offsetLeft: 0, scrolls: [], clicks: 0,
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getBoundingClientRect() {
      let top = this.offsetTop;
      let left = this.offsetLeft;
      for (let parent = this.parentElement; parent; parent = parent.parentElement) { top += parent.offsetTop - parent.scrollTop; left += parent.offsetLeft - parent.scrollLeft; }
      return { width: this.clientWidth, height: this.clientHeight, x: left, y: top, top, left, right: left + this.clientWidth, bottom: top + this.clientHeight };
    },
    querySelectorAll(selector) { return this.queries.get(selector) || (selector === "*" ? this.children : []); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector.includes("[hidden]") && current.hidden) return current;
        if (selector.includes("[inert]") && current.inert) return current;
        if (/(?:^|,)main(?:,|$)/.test(selector) && current.tagName === "MAIN") return current;
        if (/(?:^|,)aside(?:,|$)/.test(selector) && current.tagName === "ASIDE") return current;
        if (/(?:^|,)nav(?:,|$)/.test(selector) && current.tagName === "NAV") return current;
      }
      return null;
    },
    matches(selector) { return selector.split(",").some((part) => part.trim() === this.tagName.toLowerCase()); },
    compareDocumentPosition(other) {
      const rootOf = node => { while (node.parentElement) node = node.parentElement; return node; };
      const root = rootOf(this);
      if (root !== rootOf(other)) return 1;
      const ordered = [];
      const visit = node => { ordered.push(node); node.children.forEach(visit); };
      visit(root);
      return ordered.indexOf(this) < ordered.indexOf(other) ? 4 : 2;
    },
    contains(other) { return other === this || this.children.some((child) => child.contains(other)); },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    emit(name, extra = {}) { for (const listener of [...(listeners.get(name) || [])]) listener({ type: name, target: this, ...extra }); },
    click() { this.clicks += 1; this.emit("click"); },
    scrollTo(options) { if (!this.blockScroll) { if (options.top !== undefined) this.scrollTop = Math.min(Math.max(0, options.top), Math.max(0, this.scrollHeight - this.clientHeight)); if (options.left !== undefined) this.scrollLeft = Math.max(0, options.left); } this.scrolls.push({ ...options }); },
    scrollBy(options) { this.scrollTo({ ...options, top: this.scrollTop + (options.top || 0), left: this.scrollLeft + (options.left || 0) }); },
    scrollIntoView(options) { this.scrollIntoViewCalls = (this.scrollIntoViewCalls || 0) + 1; const root = this.ownerDocument?.scrollingElement; if (root && !root.blockScroll) { const rect = this.getBoundingClientRect(); root.scrollTo({ top: root.scrollTop + rect.top + rect.height / 2 - 450, behavior: options?.behavior }); } }
  };
}

function mediaElement(attributes = {}, autoplayBlocked = false) {
  const media = element("video", "", { src: "https://e.huawei.com/media/lesson.mp4", ...attributes });
  Object.assign(media, { currentTime: 0, duration: 10, readyState: 4, paused: true, ended: false, loop: false, muted: false, playCalls: 0, pauseCalls: 0 });
  media.play = function () {
    this.playCalls += 1;
    if (autoplayBlocked) return Promise.reject(Object.assign(new Error("Autoplay disabled"), { name: "NotAllowedError" }));
    this.paused = false; this.ended = false; this.emit("playing"); return Promise.resolve();
  };
  media.pause = function () { this.pauseCalls += 1; this.paused = true; this.emit("pause"); };
  media.finish = function () { this.currentTime = this.duration; this.ended = true; this.paused = true; this.emit("ended"); };
  return media;
}

function createContent({ type = "text", title = "网络基础 · 文本", textLength = 600, autoplayBlocked = false, mediaTop = 235 } = {}) {
  const clock = fakeClock();
  const outbound = [];
  const onMessage = event();
  const observers = [];
  const windows = new Map();
  const main = element("main");
  const heading = element("h2", title);
  const catalog = element("nav");
  const active = element("button", title, { "data-task-id": "task-one", "data-type": type });
  active.className = "task-item active";
  const next = element("button", "下一项", { rel: "next" });
  const reader = element("article", "学习内容".repeat(Math.ceil(textLength / 4)));
  reader.style.overflowY = "auto";
  reader.scrollHeight = 3000;
  const media = mediaElement({}, autoplayBlocked);
  media.offsetTop = mediaTop;
  main.children = [heading, type === "video" ? media : reader];
  for (const child of main.children) child.parentElement = main;
  catalog.children = [active]; active.parentElement = catalog;
  const nodes = [main, heading, catalog, active, next, reader, media];
  const mappings = new Map([
    ["*", nodes], ["main", [main]], ["main h2", [heading]], [".task-item.active", [active]], ["[data-task-id].active", [active]],
    ["[data-task-id]", [active]], [".task-item", [active]], ["#active", [active]], ["#next", [next]], ["#reader", [reader]], ["#video", [media]],
    ["button,a,[role='button'],[title],[aria-label]", [active, next]],
    ["a[rel='next'],button[rel='next'],[data-action='next-task'],[data-action='next-lesson'],.vjs-next-control,.next-lesson,.next-task,.next-section", [next]]
  ]);
  if (type === "video") mappings.set("video", [media]);
  else if (type === "document") mappings.set(".document-viewer", [reader]);
  else mappings.set(".reader-content", [reader]);
  const document = {
    title, documentElement: element("html"), scrollingElement: element("html"),
    querySelectorAll(selector) {
      if (selector === "[") throw new SyntaxError("Invalid selector");
      return mappings.get(selector) || [];
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  };
  document.documentElement = document.scrollingElement;
  document.scrollingElement.clientWidth = 1200;
  document.scrollingElement.clientHeight = document.scrollingElement.scrollHeight = 900;
  main.parentElement = document.scrollingElement;
  catalog.parentElement = next.parentElement = document.scrollingElement;
  document.scrollingElement.children = [main, catalog, next];
  nodes.forEach(node => { node.ownerDocument = document; });
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const math = Object.create(Math); math.random = () => 0;
  const chrome = { runtime: { onMessage, async sendMessage(message) { outbound.push(structuredClone(message)); return { ok: true }; } } };
  const context = vm.createContext({ chrome, document, console, URL, location: new URL("https://e.huawei.com/course/test#task-one"), Date: clock.Date, performance: clock.performance,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    MutationObserver, Math: math, innerHeight: 900, innerWidth: 1200, getComputedStyle: (node) => node.style, matchMedia: () => ({ matches: false }),
    addEventListener(name, callback) { if (!windows.has(name)) windows.set(name, []); windows.get(name).push(callback); },
    removeEventListener(name, callback) { const list = windows.get(name); if (list) { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1); } },
    scrollTo(options) { document.scrollingElement.scrollTo(options); },
    scrollBy(options) { document.scrollingElement.scrollBy(options); }
  });
  vm.runInContext("window = globalThis; self = globalThis; parent = globalThis; top = globalThis;", context);
  const script = fs.readFileSync(path.resolve(__dirname, "../../content.js"), "utf8");
  vm.runInContext(script, context, { filename: "content.js" });
  async function ask(type, extra = {}) {
    let response;
    for (const listener of onMessage.listeners) listener({ type, ...extra }, {}, (value) => { response = value; });
    await clock.settle();
    return response;
  }
  return { clock, outbound, ask, context, script, mappings, nodes, main, heading, catalog, active, next, reader, media,
    mutate() { observers.forEach((observer) => observer.callback([{ type: "childList" }])); },
    emitWindow(name, details = {}) { for (const callback of windows.get(name) || []) callback(details); },
    snapshot() { return outbound.filter((message) => message.type === "ENGINE_PROGRESS").at(-1)?.snapshot; }
  };
}

module.exports = { createContent, element, mediaElement };
