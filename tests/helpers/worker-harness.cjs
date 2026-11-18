"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    hasListener(listener) { return listeners.includes(listener); },
    async dispatch(...args) { return Promise.all(listeners.map((listener) => listener(...args))); }
  };
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys = null) {
      if (keys === null) return structuredClone(data);
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(data[key])]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, structuredClone(key in data ? data[key] : fallback)]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async clear() { for (const key of Object.keys(data)) delete data[key]; },
    async setAccessLevel() {}
  };
}

function fakeClock(start = 1_800_000_000_000) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  const NativeDate = Date;
  class ClockDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function schedule(callback, delay, interval, args) {
    const id = ++sequence;
    timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0), interval, args });
    return id;
  }
  async function settle(turns = 16) { for (let index = 0; index < turns; index++) await Promise.resolve(); }
  return {
    Date: ClockDate,
    performance: { now: () => now - start },
    now: () => now,
    setTimeout: (callback, delay, ...args) => schedule(callback, delay, 0, args),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay, ...args) => schedule(callback, delay, Math.max(1, Number(delay) || 1), args),
    clearInterval: (id) => timers.delete(id),
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (let iteration = 0; iteration < 10_000; iteration++) {
        await settle();
        let selectedId;
        let selected;
        for (const [id, timer] of timers) if (timer.due <= until && (!selected || timer.due < selected.due)) { selected = timer; selectedId = id; }
        if (!selected) { now = until; await settle(); return; }
        now = selected.due;
        if (selected.interval) selected.due += selected.interval;
        else timers.delete(selectedId);
        await selected.callback(...selected.args);
      }
      throw new Error("Fake clock exceeded 10,000 timer callbacks");
    },
    settle,
    timers
  };
}

function createWorker({ local = {}, session = {}, frames = [0], granted = true, frameHandlers = {}, tab = {} } = {}) {
  const clock = fakeClock();
  const messages = [];
  const broadcasts = [];
  const registrations = [];
  const tabInfo = { id: 7, url: "https://e.huawei.com/en/talent/ict-academy/#/course/test", title: "测试课程", status: "complete", ...tab };
  const chrome = {
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event(), lastError: null, getURL: (file) => `chrome-extension://itc-test/${file}`, async sendMessage(message) { broadcasts.push(structuredClone(message)); } },
    storage: { local: memoryStorage(local), session: memoryStorage(session), onChanged: event() },
    permissions: { async contains(request) { return typeof granted === "function" ? granted(request) : granted; }, async request(request) { return typeof granted === "function" ? granted(request) : granted; }, async getAll() { return { origins: granted ? ["https://e.huawei.com/*"] : [], permissions: ["storage", "scripting", "activeTab"] }; }, onRemoved: event(), onAdded: event() },
    scripting: {
      async registerContentScripts(items) { registrations.push(...structuredClone(items)); },
      async getRegisteredContentScripts() { return structuredClone(registrations); },
      async unregisterContentScripts({ ids } = {}) { for (let index = registrations.length - 1; index >= 0; index--) if (!ids || ids.includes(registrations[index].id)) registrations.splice(index, 1); },
      async updateContentScripts(items) { for (const item of items) Object.assign(registrations.find((current) => current.id === item.id) || {}, structuredClone(item)); },
      async executeScript() { return frames.map((frameId) => ({ frameId, documentId: `document-${frameId}`, result: null })); }
    },
    tabs: {
      onRemoved: event(), onUpdated: event(), onReplaced: event(),
      async get(id) { if (id !== tabInfo.id) throw new Error("No tab with id"); return structuredClone(tabInfo); },
      async query() { return [structuredClone(tabInfo)]; },
      async sendMessage(tabId, message, options = {}) {
        messages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        const handler = frameHandlers[options.frameId ?? 0];
        if (!handler) throw new Error("Could not establish connection. Receiving end does not exist.");
        return handler(message, options);
      }
    },
    webNavigation: { async getAllFrames() { return frames.map((frameId) => ({ frameId, parentFrameId: frameId === 0 ? -1 : 0, url: tabInfo.url })); }, onCommitted: event(), onHistoryStateUpdated: event() },
    alarms: { onAlarm: event(), async create() {}, async clear() { return true; }, async getAll() { return []; } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} }
  };
  const context = vm.createContext({ chrome, console, URL, Date: clock.Date, performance: clock.performance, structuredClone, crypto: require("node:crypto").webcrypto, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, queueMicrotask, TextEncoder, TextDecoder });
  context.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file }));
  context.importScripts("background.js");

  async function request(message, sender = {}) {
    await clock.settle();
    const result = await new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of chrome.runtime.onMessage.listeners) {
        try {
          const returned = listener(message, sender, (value) => { handled = true; resolve(value); });
          if (returned && typeof returned.then === "function") {
            handled = true;
            returned.then(resolve, reject);
          }
          if (returned === true) handled = true;
          else if (returned !== undefined && returned !== false && !(returned && typeof returned.then === "function")) { handled = true; resolve(returned); }
        } catch (error) { reject(error); }
      }
      if (!handled) resolve(undefined);
    });
    await clock.settle();
    return result;
  }
  return { chrome, clock, messages, broadcasts, registrations, request, context, tabInfo, frameHandlers };
}

module.exports = { createWorker, fakeClock, memoryStorage, event };
