"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../shared.js"), "utf8"), context);
const shared = context.StudyShared;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("untrusted persisted settings cannot disable defaults or create an unbounded scrolling interval", () => {
  const defaults = plain(shared.DEFAULTS);
  for (const bad of [null, undefined, "settings", true, []]) {
    assert.deepEqual(plain(shared.normalizeSettings(bad)), defaults);
  }
  const restored = shared.normalizeSettings({ theme: "sepia", scrollIntervalSeconds: Infinity, scrollEnabled: "false", autoNext: null, muteVideo: 1, nextDelaySeconds: NaN });
  assert.deepEqual(plain(restored), defaults);
  assert.equal(shared.normalizeSettings({ scrollIntervalSeconds: -10 }).scrollIntervalSeconds, 1);
  assert.equal(shared.normalizeSettings({ scrollIntervalSeconds: 1_000_000 }).scrollIntervalSeconds, 3600);
  assert.equal(shared.normalizeSettings({ nextDelaySeconds: -3 }).nextDelaySeconds, 0);
  assert.equal(shared.normalizeSettings({ nextDelaySeconds: 31 }).nextDelaySeconds, 30);
});

test("valid settings round-trip without losing explicit false controls or selector overrides", () => {
  const expected = {
    theme: "dark", scrollIntervalSeconds: 20, scrollEnabled: false, autoNext: false, muteVideo: false,
    nextDelaySeconds: 0,
    selectors: { video: "#course-video", document: ".reader", scroll: ".actual-scroll-wrap", next: "button.next", task: "[data-task-id]", activeTask: "[aria-current=true]", completed: "[data-completed=true]" }
  };
  const saved = shared.normalizeSettings(expected);
  assert.deepEqual(plain(saved), expected);
  saved.selectors.video = "#changed-after-save";
  assert.equal(expected.selectors.video, "#course-video", "normalization must not return the caller's nested selector object");
  assert.equal(shared.DEFAULTS.selectors.video, "", "caller changes must not contaminate subsequent default settings");
});

test("legacy reading duration is discarded instead of becoming a scroll interval", () => {
  const restored = shared.normalizeSettings({ readSeconds: 120, scrollEnabled: false });
  assert.equal(restored.scrollIntervalSeconds, 10);
  assert.equal(restored.scrollEnabled, false);
  assert.equal(Object.hasOwn(restored, "readSeconds"), false);
  assert.equal(shared.normalizeSettings({ readSeconds: 900, scrollIntervalSeconds: 8 }).scrollIntervalSeconds, 8);
});

test("selector values are bounded and only known configuration fields survive", () => {
  const restored = shared.normalizeSettings({ remoteCode: "alert(1)", selectors: { video: "  video.course  ", next: "x".repeat(2000), document: true, injected: "script" } });
  assert.equal(restored.selectors.video, "video.course");
  assert.equal(restored.selectors.next.length, 1000);
  assert.equal(restored.selectors.document, "");
  assert.ok(!Object.hasOwn(restored, "remoteCode"));
  assert.ok(!Object.hasOwn(restored.selectors, "injected"));
});

test("public timer labels remain stable at boundaries", () => {
  assert.equal(shared.formatTime(-1), "00:00");
  assert.equal(shared.formatTime(59.9), "00:59");
  assert.equal(shared.formatTime(60), "01:00");
  assert.equal(shared.formatTime(10_800), "180:00");
  assert.equal(shared.formatTime("bad"), "00:00");
  assert.equal(shared.typeLabel("document"), "文档");
  assert.equal(shared.typeLabel("unexpected"), "待识别");
});
