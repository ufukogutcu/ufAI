import assert from "node:assert/strict";
import { test } from "node:test";
import { angleAt, circlePoint, CONNECTION_RADIUS, nearestRingTarget, normalizeAngle, radialPath, ringCenter, type RingNode } from "../src/connection-geometry";
import { createConnectionDragStore } from "../src/connection-drag";
import { connectionArcRanges, connectionRingPaths, effectiveAnchorAngle } from "../src/connection-appearance";
import type { CommunicationLink } from "../../server/src/contracts";

const link: CommunicationLink = { id: "link", workspaceId: "workspace", sourceAgentId: "a", targetAgentId: "b", sourceAnchorAngle: 0, targetAnchorAngle: 180, state: "active", createdAt: "now" };
test("idle arcs span 24 degrees, wrap at zero, and merge duplicate or overlapping connection points", () => {
  assert.deepEqual(connectionArcRanges([]), []);
  assert.deepEqual(connectionArcRanges([90]), [[78, 102]]);
  assert.deepEqual(connectionArcRanges([0]), [[0, 12], [348, 360]]);
  assert.deepEqual(connectionArcRanges([359, 1, 1]), [[0, 13], [347, 360]]);
  assert.deepEqual(connectionArcRanges([90, 100, 114, 180]), [[78, 126], [168, 192]]);
  assert.deepEqual(connectionArcRanges([-1, 361]), connectionArcRanges([359, 1]));
  assert.deepEqual(connectionArcRanges(Array.from({ length: 30 }, (_, i) => i * 12)), [[0, 360]]);
});
test("idle and reveal paths partition the circumference, including unconnected and fully covered rings", () => {
  const center = { x: 117, y: 117 };
  const empty = connectionRingPaths([], center);
  assert.equal(empty.arcs, "");
  assert.equal((empty.remainder.match(/A95,95/g) ?? []).length, 2);
  const connected = connectionRingPaths([90], center);
  const from = circlePoint(center, 78), to = circlePoint(center, 102);
  assert.ok(connected.arcs.startsWith(`M${from.x},${from.y}`));
  assert.ok(connected.arcs.endsWith(`${to.x},${to.y}`));
  const full = connectionRingPaths(Array.from({ length: 30 }, (_, i) => i * 12), center);
  assert.equal(full.remainder, "");
  assert.doesNotMatch(JSON.stringify([empty, connected, full]), /NaN|Infinity/);
});
test("arcs and lines resolve saved, draft and live angles together and restore drafts after cancellation", () => {
  const { store, nodes, calls } = fixture();
  const draft = { sourceAnchorAngle: 25, targetAnchorAngle: 190 };
  assert.equal(effectiveAnchorAngle(link, "sourceAnchorAngle"), 0);
  assert.equal(effectiveAnchorAngle(link, "sourceAnchorAngle", draft), 25);
  store.getState().beginEdit("link", "sourceAnchorAngle", 25);
  store.getState().move(circlePoint(ringCenter(nodes[0]!.position), 90));
  const drag = store.getState().drag;
  if (drag?.kind !== "edit") assert.fail();
  assert.equal(effectiveAnchorAngle(link, "sourceAnchorAngle", draft, drag), 90);
  assert.deepEqual(connectionArcRanges([effectiveAnchorAngle(link, "sourceAnchorAngle", draft, drag)]), [[78, 102]]);
  assert.equal(effectiveAnchorAngle(link, "targetAnchorAngle", draft, drag), 190);
  assert.equal(effectiveAnchorAngle({ ...link, id: "other" }, "sourceAnchorAngle", draft, drag), 25);
  store.getState().cancel();
  assert.equal(effectiveAnchorAngle(link, "sourceAnchorAngle", draft), 25);
  assert.deepEqual(calls, []);
});
function fixture() {
  const nodes: RingNode[] = [{ id: "a", position: { x: 0, y: 0 }, zIndex: 1, order: 0 }, { id: "b", position: { x: 400, y: 100 }, zIndex: 1, order: 1 }];
  const calls: unknown[] = [];
  const store = createConnectionDragStore({ nodes: () => nodes, link: () => link,
    create: async (...args) => { calls.push(["create", ...args]); }, save: async (...args) => { calls.push(["save", ...args]); } });
  return { nodes, calls, store };
}
test("radial geometry projects onto the circle, normalizes angles, and follows absolute Cluster coordinates", () => {
  const center = ringCenter({ x: 300 + 24, y: 100 + 72 });
  assert.deepEqual(center, { x: 412, y: 284 });
  for (const angle of [0, 25.5, 90, 180, 270, 359.9]) {
    const point = circlePoint(center, angle);
    assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - CONNECTION_RADIUS) < 1e-9);
    assert.ok(Math.abs(angleAt(center, point) - angle) < 1e-9);
    const moved = circlePoint({ x: center.x + 32, y: center.y - 16 }, angle);
    assert.ok(Math.abs(moved.x - point.x - 32) < 1e-9);
    assert.ok(Math.abs(moved.y - point.y + 16) < 1e-9);
  }
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(720), 0);
  assert.equal(angleAt(center, center, 180), 180);
  assert.doesNotMatch(radialPath(center, 0, center, 180), /NaN|Infinity/);
});
test("overlap targeting chooses the closest circumference, then stacking order, excluding the source", () => {
  const nodes: RingNode[] = [
    { id: "source", position: { x: 100, y: 0 }, zIndex: 10, order: 3 },
    { id: "farther-boundary", position: { x: 100, y: 0 }, zIndex: 9, order: 0 },
    { id: "nearer-boundary", position: { x: 0, y: 0 }, zIndex: 1, order: 1 },
  ];
  const point = ringCenter({ x: CONNECTION_RADIUS * 0.8, y: 0 });
  assert.equal(nearestRingTarget(nodes, "source", point)?.id, "nearer-boundary");
  nodes.push({ id: "front", position: { x: 0, y: 0 }, zIndex: 2, order: 2 });
  assert.equal(nearestRingTarget(nodes, "source", point)?.id, "front");
  nodes.push({ id: "later", position: { x: 0, y: 0 }, zIndex: 2, order: 4 });
  assert.equal(nearestRingTarget(nodes, "source", point)?.id, "later");
  assert.equal(nearestRingTarget(nodes, "source", { x: 1000, y: 1000 }), undefined);
});
test("creation holds the starting point fixed, previews a radial target, and only writes on completion", async () => {
  const { nodes, calls, store } = fixture();
  store.getState().beginCreate("a", circlePoint(ringCenter(nodes[0]!.position), 90));
  store.getState().move(circlePoint(ringCenter(nodes[1]!.position), 180, CONNECTION_RADIUS + 10));
  const outside = store.getState().drag;
  assert.equal(outside?.kind === "create" ? outside.targetId : undefined, undefined);
  store.getState().move(circlePoint(ringCenter(nodes[1]!.position), 180, CONNECTION_RADIUS - 10));
  const drag = store.getState().drag;
  assert.equal(drag?.kind, "create");
  if (drag?.kind !== "create") assert.fail();
  assert.equal(drag.sourceAngle, 90);
  assert.equal(drag.targetAngle, 180);
  assert.equal(drag.targetId, "b");
  assert.deepEqual(calls, []);
  await store.getState().finish();
  assert.deepEqual(calls, [["create", "a", "b", { sourceAnchorAngle: 90, targetAnchorAngle: 180 }]]);
  assert.equal(store.getState().drag, null);
});
test("empty drops, pointer cancellation, Escape cancellation, and deleted agents do not create links", async () => {
  const { nodes, calls, store } = fixture();
  const start = () => store.getState().beginCreate("a", circlePoint(ringCenter(nodes[0]!.position), 0));
  start(); store.getState().move({ x: 1000, y: 1000 }); await store.getState().finish();
  start(); store.getState().move(ringCenter(nodes[1]!.position)); store.getState().cancel(); await store.getState().finish();
  start(); nodes.splice(0, 1); store.getState().validate(); await store.getState().finish();
  assert.deepEqual(calls, []);
});
test("endpoint adjustment stays on its original agent and cancellation restores saved geometry", async () => {
  const { nodes, calls, store } = fixture();
  store.getState().beginEdit("link", "sourceAnchorAngle", 0);
  store.getState().move(circlePoint(ringCenter(nodes[0]!.position), 270, 500));
  assert.equal(store.getState().drag?.kind === "edit" && store.getState().drag?.angle, 270);
  assert.deepEqual(calls, []);
  store.getState().cancel(); await store.getState().finish();
  assert.deepEqual(calls, []);
  store.getState().beginEdit("link", "sourceAnchorAngle", 0);
  store.getState().move(circlePoint(ringCenter(nodes[0]!.position), 90));
  await store.getState().finish();
  assert.deepEqual(calls, [["save", "link", { sourceAnchorAngle: 90 }]]);
  assert.equal(link.sourceAgentId, "a"); assert.equal(link.targetAgentId, "b");
});
