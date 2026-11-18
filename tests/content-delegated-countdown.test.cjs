"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

async function delegatedOwner() {
  const owner = createContent();
  owner.reader.style.overflowY = "visible";
  owner.reader.clientHeight = owner.reader.scrollHeight = 200;
  const frame = element("iframe", "", { src: "https://talent.shixizhi.huawei.com/local-reader" });
  Object.assign(frame, { offsetTop: 235, clientHeight: 430, clientWidth: 1200,
    parentElement: owner.main, contentWindow: { postMessage() {} } });
  owner.main.children = [owner.heading, owner.reader, frame];
  owner.mappings.set("iframe", [frame]);
  owner.context.document.scrollingElement.scrollHeight = 2000;
  await owner.ask("ENGINE_RUN", { settings: { scrollIntervalSeconds: 3 }, runId: "owner-run" });
  const request = owner.outbound.find(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.ok(request, "the owner delegates its centered iframe");
  const childSnapshot = { phase: "reading", taskType: "text", detail: "继续逐段阅读",
    scroll: { enabled: true, state: "scheduled", movements: 6, intervalSeconds: 3,
      nextAt: owner.clock.now() + 3000, sampledAt: owner.clock.now(), nextInSeconds: 3 } };
  const update = snapshot => owner.ask("ENGINE_EMBEDDED_STATUS", { token: request.token, runId: "owner-run", snapshot });
  return { owner, request, childSnapshot, update };
}

test("an iframe owner forwards its child's actual reading clock and movements across cached reports", async () => {
  const { owner, childSnapshot, update } = await delegatedOwner();
  await update(childSnapshot);
  assert.equal(owner.snapshot().taskType, "text");
  assert.equal(owner.snapshot().scroll.movements, 6);
  assert.equal(owner.snapshot().scroll.enabled, true);
  assert.equal(owner.snapshot().scroll.nextAt, childSnapshot.scroll.nextAt);
  assert.equal(owner.snapshot().scroll.nextInSeconds, 3);
  await owner.clock.advance(1000);
  assert.equal(owner.snapshot().scroll.nextInSeconds, 2);
  assert.equal(owner.snapshot().scroll.nextAt, childSnapshot.scroll.nextAt, "owner reports cannot extend the child's deadline");
  childSnapshot.scroll = { ...childSnapshot.scroll, movements: 7, nextAt: owner.clock.now() + 2800,
    sampledAt: owner.clock.now(), nextInSeconds: 2.8, intervalSeconds: 2.8 };
  await update(childSnapshot);
  assert.equal(owner.snapshot().scroll.movements, 7);
  assert.equal(owner.snapshot().scroll.nextInSeconds, 2.8);
});

test("stale iframe clocks cannot overwrite current progress or revive a paused owner", async () => {
  const { owner, request, childSnapshot, update } = await delegatedOwner();
  await update(childSnapshot);
  const stale = { ...childSnapshot, scroll: { ...childSnapshot.scroll, movements: 99 } };
  await owner.ask("ENGINE_EMBEDDED_STATUS", { token: "wrong-token", runId: "owner-run", snapshot: stale });
  await owner.ask("ENGINE_EMBEDDED_STATUS", { token: request.token, runId: "previous-run", snapshot: stale });
  assert.equal(owner.snapshot().scroll.movements, 6);
  const paused = await owner.ask("ENGINE_PAUSE");
  assert.equal(paused.snapshot.phase, "paused");
  assert.equal(paused.snapshot.scroll.nextAt, null);
  assert.equal(paused.snapshot.scroll.enabled, false);
  await update(stale);
  assert.equal(owner.snapshot().phase, "paused");
  assert.equal(owner.snapshot().scroll.movements, 6);
});

test("an owner's reading display preserves child expansion and missing timer states", async () => {
  const { owner, childSnapshot, update } = await delegatedOwner();
  childSnapshot.scroll = { ...childSnapshot.scroll, state: "expanding", nextAt: null, nextInSeconds: null };
  await update(childSnapshot);
  assert.equal(owner.snapshot().scroll.state, "expanding");
  assert.equal(owner.snapshot().scroll.nextAt, null);
  assert.equal(owner.snapshot().scroll.nextInSeconds, null);
  assert.equal(owner.snapshot().scroll.movements, 6);
});
