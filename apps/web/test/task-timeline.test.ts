import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTimelineStore,
  actionLabel,
  toolLabels,
} from "../src/task-timeline.js";
import type {
  TimelineEntry,
  TimelinePage,
} from "../../server/src/contracts.js";
import { taskTools } from "../../server/src/agent-tools.js";
function item(id: string, order = id): TimelineEntry {
  return {
    id,
    order,
    createdAt: "2026-01-01T00:00:00.000Z",
    turnId: "turn",
    kind: "action",
    name: "files_read",
    status: "running",
    arguments: { path: "guide.md" },
  };
}
function page(
  items: TimelineEntry[],
  before: string | null = null,
  updates: TimelineEntry[] = [],
  removed: string[] = [],
): TimelinePage {
  return { items, before, updates, removed };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("refreshes coalesce and rerun after a newer invalidation", async () => {
  const first = deferred<TimelinePage>();
  let calls = 0;
  const store = createTimelineStore("task", async () =>
    ++calls === 1
      ? first.promise
      : page([{ ...item("a"), status: "completed" }]),
  );
  const running = store.getState().refresh();
  void store.getState().refresh();
  first.resolve(page([item("a")]));
  await running;
  assert.equal(calls, 2);
  assert.equal(store.getState().items[0]?.status, "completed");
});
test("history merges by stable identity, and removed communications leave no duplicate", async () => {
  let calls = 0;
  const store = createTimelineStore("task", async (before, watch) => {
    calls++;
    if (calls === 1)
      return page([{ ...item("c"), kind: "communication" }], "b");
    if (before) return page([item("a")]);
    assert.ok(watch.includes("c"));
    return page([item("d")], null, [], ["c"]);
  });
  await store.getState().refresh();
  await store.getState().more();
  await store.getState().refresh();
  assert.deepEqual(
    store.getState().items.map((i) => i.id),
    ["a", "d"],
  );
});
test("large live bursts fill their pagination gap and preserve watched updates", async () => {
  let calls = 0;
  const store = createTimelineStore("task", async (before) => {
    calls++;
    if (calls === 1) return page([item("a")]);
    if (before) return page([item("b"), item("a")]);
    return page([item("d"), item("c")], "b", [
      { ...item("a"), status: "failed" },
    ]);
  });
  await store.getState().refresh();
  await store.getState().refresh();
  assert.deepEqual(
    store.getState().items.map((i) => i.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(store.getState().items[0]?.status, "failed");
});
test("disposed requests cannot populate a departed conversation", async () => {
  const read = deferred<TimelinePage>();
  const store = createTimelineStore("task", () => read.promise);
  const loading = store.getState().refresh();
  store.getState().dispose();
  read.resolve(page([item("a")]));
  await loading;
  assert.equal(store.getState().items.length, 0);
});
test("failed refresh preserves history and recovers on the next request", async () => {
  let count = 0;
  const store = createTimelineStore("task", async () => {
    count++;
    if (count === 2) throw Error("Offline");
    return page([item("a")]);
  });
  await store.getState().refresh();
  await store.getState().refresh();
  assert.equal(store.getState().error, "Offline");
  assert.equal(store.getState().items.length, 1);
  await store.getState().refresh();
  assert.equal(store.getState().error, "");
});
test("every discoverable tool has readable copy and failures never claim success", () => {
  for (const tool of taskTools) assert.ok(toolLabels[tool.name], tool.name);
  assert.match(
    actionLabel({ ...item("a"), status: "failed" }),
    /^Reading file/,
  );
  assert.match(
    actionLabel({ ...item("a"), status: "completed" }),
    /^Read file/,
  );
  assert.match(
    actionLabel({ ...item("a"), name: "future_tool" }),
    /^Running action/,
  );
  assert.match(
    actionLabel({
      ...item("a"),
      name: "agent_send",
      contextName: "Researcher",
    }),
    /to Researcher/,
  );
});

test("unrelated invalidations preserve transcript and row references", async () => {
  const store = createTimelineStore("task", async () =>
    page([{ ...item("a"), status: "completed" }]),
  );
  await store.getState().refresh();
  const previous = store.getState().items;
  await store.getState().refresh();
  assert.equal(store.getState().items, previous);
  assert.equal(store.getState().items[0], previous[0]);
});

test("large command arguments stay readable without filling the timeline", () => {
  const label = actionLabel({
    ...item("a"),
    name: "process_start",
    arguments: { command: "python " + "x".repeat(16000) },
  });
  assert.ok(label.length < 220);
  assert.ok(label.includes("Starting command"));
});
