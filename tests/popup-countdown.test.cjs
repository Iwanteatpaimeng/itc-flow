"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { fakeClock, event } = require("./helpers/worker-harness.cjs");

function popup(overrides = {}) {
  const clock = fakeClock();
  const nodes = new Map();
  const node = () => ({
    hidden: false, textContent: "", value: "system", style: {}, dataset: {}, attributes: {}, children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }
  });
  const select = selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  select("#modalBackdrop").hidden = true;
  const document = {
    hidden: false, documentElement: node(), querySelector: select, querySelectorAll: () => [],
    createElement: node, createElementNS: node, addEventListener() {}
  };
  const runtimeMessages = event();
  let current = {
    phase: "reading", taskType: "text", running: true, updatedAt: clock.now(),
    scroll: { state: "scheduled", movements: 1, nextInSeconds: 10, intervalSeconds: 10,
      nextAt: clock.now() + 10000, sampledAt: clock.now() },
    ...overrides
  };
  const chrome = {
    runtime: { onMessage: runtimeMessages, async sendMessage() { return {
      ok: true, status: structuredClone(current), permission: true,
      connection: { available: true, message: "已就绪" }
    }; } },
    storage: { local: { async get() { return {}; } }, onChanged: event() },
    tabs: { async query() { return [{ id: 7, url: "https://e.huawei.com/course" }]; } }
  };
  const context = vm.createContext({ document, chrome, Date: clock.Date, URL,
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  const root = path.resolve(__dirname, "..");
  vm.runInContext(fs.readFileSync(path.join(root, "shared.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "popup.js"), "utf8"), context);
  return { clock, nodes, async update(status) {
    current = structuredClone(status);
    await runtimeMessages.dispatch({ type: "STATUS_UPDATED", tabId: 7, status: current });
    await clock.settle();
  }, status: () => structuredClone(current), time: () => select("#timeDisplay").textContent,
  percent: () => Number(select("#progressFill").style.width.replace("%", "")) };
}

test("a reading countdown advances locally through unchanged cached status replies and calibrates each new interval", async () => {
  const ui = popup();
  await ui.clock.settle();
  assert.equal(ui.time(), "00:10");
  await ui.clock.advance(5500);
  assert.equal(ui.time(), "00:05", "cached worker replies cannot rewind the displayed seconds");
  assert.ok(Math.abs(ui.percent() - 55) < 0.001);
  const next = ui.status();
  next.scroll = { ...next.scroll, movements: 2, intervalSeconds: 9.5,
    nextInSeconds: 9.5, nextAt: ui.clock.now() + 9500, sampledAt: ui.clock.now() };
  await ui.update(next);
  assert.equal(ui.time(), "00:10");
  assert.equal(ui.percent(), 0);
  await ui.clock.advance(2500);
  assert.equal(ui.time(), "00:07");
  await ui.clock.advance(7000);
  assert.equal(ui.time(), "滚动中", "an expired interval must wait for a real new deadline");
  await ui.clock.advance(2000);
  assert.equal(ui.time(), "滚动中", "the popup cannot invent another scroll cycle");
});

test("reading a mixed video task uses live scroll time, while pause, expansion and playback show their actual states", async () => {
  const ui = popup({ taskType: "video" });
  await ui.clock.settle();
  await ui.clock.advance(2000);
  assert.equal(ui.time(), "00:08", "a detected video does not imply that it is playing");
  let status = ui.status();
  status.phase = "paused"; status.running = false;
  await ui.update(status);
  await ui.clock.advance(3000);
  assert.equal(ui.time(), "已暂停");
  status.phase = "reading"; status.running = true; status.scroll.state = "expanding"; status.scroll.nextAt = null;
  await ui.update(status);
  assert.equal(ui.time(), "展开中");
  status.phase = "blocked";
  await ui.update(status);
  assert.equal(ui.time(), "待操作");
  status.phase = "playing"; status.scroll.state = "video"; status.videoCurrent = 15; status.videoDuration = 120;
  await ui.update(status);
  assert.equal(ui.time(), "00:15 / 02:00");
  status.phase = "waiting_completion";
  await ui.update(status);
  assert.equal(ui.time(), "待确认");
});

test("older snapshots use their sample timestamp without restarting on repeated polls", async () => {
  const ui = popup();
  const status = ui.status();
  delete status.scroll.nextAt;
  await ui.clock.settle();
  await ui.update(status);
  await ui.clock.advance(5250);
  assert.equal(ui.time(), "00:05");
  await ui.clock.advance(4750);
  assert.equal(ui.time(), "滚动中");
});

test("a delegated reading view shows synchronization status until its real child clock arrives", async () => {
  const ui = popup({ taskType: "text", flow: { embeddedActive: true },
    scroll: { state: "video", enabled: false, movements: 1, nextAt: null, nextInSeconds: null, intervalSeconds: 3 } });
  await ui.clock.settle();
  assert.equal(ui.time(), "同步中", "an absent iframe deadline must not become a blank or invented countdown");
  const status = ui.status();
  status.scroll = { state: "scheduled", enabled: true, movements: 6, nextAt: ui.clock.now() + 3000,
    sampledAt: ui.clock.now(), nextInSeconds: 3, intervalSeconds: 3 };
  await ui.update(status);
  assert.equal(ui.time(), "00:03");
  await ui.clock.advance(1000);
  assert.equal(ui.time(), "00:02");
  status.phase = "waiting";
  await ui.update(status);
  assert.equal(ui.time(), "连接中");
  status.phase = "reading"; status.flow.embeddedActive = false;
  status.scroll.nextAt = null; status.scroll.nextInSeconds = null;
  await ui.update(status);
  assert.equal(ui.time(), "待滚动");
});

test("chapter loading keeps a pending label until the actual next scroll deadline arrives", async () => {
  const ui = popup({ phase: "waiting", taskType: "text", flow: { embeddedActive: true },
    scroll: { state: "loading_chapter", movements: 37, nextAt: null, nextInSeconds: null, intervalSeconds: 10 } });
  await ui.clock.settle();
  assert.equal(ui.time(), "加载中");
  await ui.clock.advance(5000);
  assert.equal(ui.time(), "加载中", "loading time cannot create a fictional scroll countdown");
  const status = ui.status();
  status.phase = "reading";
  status.scroll = { ...status.scroll, state: "scheduled", nextAt: ui.clock.now() + 10000, sampledAt: ui.clock.now(), nextInSeconds: 10 };
  await ui.update(status);
  assert.equal(ui.time(), "00:10");
  await ui.clock.advance(1000);
  assert.equal(ui.time(), "00:09");
});

test("a nested Word loading state shows loading until its actual reader supplies a scroll deadline", async () => {
  const ui = popup({ phase: "waiting", taskType: "document", flow: { embeddedActive: true },
    scroll: { state: "loading_document", movements: 5, nextAt: null, nextInSeconds: null, intervalSeconds: 10 } });
  await ui.clock.settle();
  assert.equal(ui.time(), "加载中");
  assert.equal(ui.nodes.get("#phaseText").textContent, "加载文档");
  await ui.clock.advance(3500);
  assert.equal(ui.time(), "加载中");
  const loaded = ui.status();
  loaded.phase = "reading";
  loaded.scroll = { ...loaded.scroll, state: "scheduled", nextAt: ui.clock.now() + 10000,
    sampledAt: ui.clock.now(), nextInSeconds: 10 };
  await ui.update(loaded);
  assert.equal(ui.time(), "00:10");
  await ui.clock.advance(1000);
  assert.equal(ui.time(), "00:09");
});
