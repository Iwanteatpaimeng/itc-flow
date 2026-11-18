"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createContent, element } = require("./helpers/content-harness.cjs");

async function advanceTogether(engines, seconds) {
  for (let step = 0; step < seconds * 4; step++) for (const engine of engines) await engine.clock.advance(250);
}

for (const layoutShift of [0, 180]) test(`an active iframe owner aligns its delegated player's projection after the introduction${layoutShift ? " and a later layout shift" : ""}`, async () => {
  const owner = createContent();
  const child = createContent({ type: "video", mediaTop: 9.5 });
  child.context.innerHeight = 720;
  child.main.style.overflowY = "auto";
  child.main.clientHeight = 400;
  child.main.scrollHeight = 2000;
  child.media.clientHeight = 381;
  owner.reader.style.overflowY = "visible";
  owner.reader.clientHeight = owner.reader.scrollHeight = 200;
  const frame = element("iframe", "", { src: "https://talent.shixizhi.huawei.com/local-delegated-reader" });
  Object.assign(frame, { offsetTop: 1000, clientHeight: 720, clientWidth: 1200,
    parentElement: owner.main, contentWindow: child.context, ownerDocument: owner.context.document });
  owner.main.children = [owner.heading, owner.reader, frame];
  owner.mappings.set("iframe", [frame]);
  owner.context.document.scrollingElement.scrollHeight = 5000;
  owner.context.postMessage = message => owner.emitWindow("message", { data: message, source: child.context });
  child.context.postMessage = message => child.emitWindow("message", { data: message, source: owner.context });
  child.context.parent = owner.context;
  child.context.top = owner.context;
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true };
  await owner.ask("ENGINE_RUN", { settings, resetPosition: true, runId: "owner-reader" });
  for (let step = 0; step < 120 && !owner.outbound.some(message => message.type === "ENGINE_EMBEDDED_REQUEST"); step++) await advanceTogether([owner, child], 0.25);
  const request = owner.outbound.find(message => message.type === "ENGINE_EMBEDDED_REQUEST");
  assert.ok(request, "the parent reads its introduction and reaches its iframe first");
  const atDelegation = owner.context.document.scrollingElement.scrollTop;
  frame.offsetTop += layoutShift;
  await child.ask("ENGINE_EMBEDDED_RUN", { settings, token: request.token, runId: "child-reader", resetPosition: true });
  await advanceTogether([owner, child], 15);
  assert.equal(child.media.playCalls, 1, "the owner must align the actual player, which has a different center from its whole iframe");
  const projected = frame.getBoundingClientRect().top + child.media.getBoundingClientRect().top + child.media.clientHeight / 2;
  assert.ok(Math.abs(projected - owner.context.innerHeight / 2) <= 80, "real projected centering is still required");
  assert.notEqual(owner.context.document.scrollingElement.scrollTop, atDelegation, "an already reached frame can move slightly to align its delegated reading viewport");
});
