"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

test("independent readers in the same viewport are traversed in document order even when later text is longer", async () => {
  const engine = createContent({ textLength: 200 });
  const first = engine.reader;
  first.clientHeight = 200;
  first.scrollHeight = 600;
  const later = element("article", "后面的较长正文".repeat(500));
  Object.assign(later, { offsetTop: 300, clientHeight: 200, scrollHeight: 1000, parentElement: engine.main, ownerDocument: engine.context.document });
  later.style.overflowY = "auto";
  engine.main.children = [engine.heading, first, later];
  engine.mappings.set(".reader-content", [first, later]);
  engine.mappings.set("*", [...engine.nodes, later]);
  await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 } });
  await engine.clock.advance(1300);
  assert.ok(first.scrollTop > 0, "the earlier reader must receive the first step");
  assert.equal(later.scrollTop, 0, "a longer later reader must wait for the earlier reader");
  await engine.clock.advance(12000);
  assert.equal(first.scrollTop, first.scrollHeight - first.clientHeight);
  assert.ok(later.scrollTop > 0, "the later reader starts after the earlier reader reaches its bottom");
});

test("unreachable player positions show a specific blocked state and recover when the position becomes centered", async () => {
  for (const mediaTop of [0, 3000]) {
    const engine = createContent({ type: "video", mediaTop });
    const root = engine.context.document.scrollingElement;
    root.scrollHeight = mediaTop ? 3430 : 900;
    await engine.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 1 } });
    await engine.clock.advance(30000);
    assert.equal(engine.media.playCalls, 0);
    assert.equal(engine.snapshot().phase, "blocked");
    assert.match(engine.snapshot().detail, /空间.*中间.*手动/);
    assert.equal(engine.outbound.some(message => message.type === "ENGINE_DONE"), false);
    engine.media.offsetTop = root.scrollTop + 235;
    await engine.clock.advance(1100);
    assert.equal(engine.media.playCalls, 1, "centering the player allows the same running task to continue");
    assert.equal(engine.snapshot().phase, "playing");
  }
});
