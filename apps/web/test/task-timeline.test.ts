import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTimelineStore,
  actionLabel,
  toolLabels,
  messageActionLabel,
} from "../src/task-timeline.js";
import type {
  TimelineEntry,
  TimelinePage,
  AgentRequest,
  CommunicationMessage,
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

const request: AgentRequest = {
  id: "request", workspaceId: "workspace", sourceAgentId: "requester", targetAgentId: "helper",
  sourceName: "Coordinator", targetName: "Researcher", sourceTaskId: "source-task", targetTaskId: "helper-task",
  rootWorkflowId: "root", parentRequestId: null, kind: "request", state: "open", error: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const communication: CommunicationMessage = {
  id: "communication", sequence: 1, requestId: request.id, senderAgentId: "requester", senderName: "Coordinator",
  senderTaskId: "source-task", recipientTaskId: "helper-task", kind: "question", content: "Any findings?",
  attachments: [], replyToId: null, createdAt: request.createdAt,
};

test("sent message labels resolve recipients by ID before a request exists", () => {
  const action = { ...item("send"), name: "agent_send", arguments: { agentId: "helper" }, contextName: "Researcher" };
  const label = messageActionLabel(action, "source-task")!;
  assert.equal(label.agentId, "helper");
  assert.equal(label.prefix, "Sending a message · to ");
  assert.equal(label.name, "Researcher");
  assert.equal(label.label, actionLabel(action));
  for (const status of ["running", "waiting", "completed", "failed", "interrupted", "cancelled"] as const) {
    assert.equal(messageActionLabel({ ...action, status }, "source-task")?.label, actionLabel({ ...action, status }));
  }
});

test("request replies identify the opposite agent from either participating task", () => {
  const action = { ...item("reply"), name: "agent_message", request };
  assert.equal(messageActionLabel(action, "source-task")?.agentId, "helper");
  assert.equal(messageActionLabel(action, "source-task")?.name, "Researcher");
  assert.equal(messageActionLabel(action, "helper-task")?.agentId, "requester");
  assert.equal(messageActionLabel(action, "helper-task")?.name, "Coordinator");
  assert.equal(messageActionLabel(action, "unrelated-task"), undefined);
});

test("standalone messages distinguish incoming senders and outgoing recipients", () => {
  const entry = { ...item("comm"), kind: "communication" as const, communication, request };
  assert.equal(messageActionLabel(entry, "helper-task")?.agentId, "requester");
  assert.equal(messageActionLabel(entry, "helper-task")?.label, "Message from Coordinator");
  assert.equal(messageActionLabel(entry, "source-task")?.agentId, "helper");
  assert.equal(messageActionLabel(entry, "source-task")?.label, "Message to Researcher");
  const reply = { ...entry, communication: { ...communication, senderAgentId: "helper", senderName: "Researcher", senderTaskId: "helper-task", recipientTaskId: "source-task" } };
  assert.equal(messageActionLabel(reply, "source-task")?.label, "Message from Researcher");
  assert.equal(messageActionLabel(reply, "helper-task")?.agentId, "requester");
});

test("missing peers retain readable copy without inventing an identity", () => {
  const entry = { ...item("reply"), name: "agent_message", request: { ...request, targetAgentId: null } };
  assert.equal(messageActionLabel(entry, "source-task")?.agentId, null);
  assert.equal(messageActionLabel(entry, "source-task")?.name, "Researcher");
  assert.equal(messageActionLabel({ ...item("comm"), kind: "communication" }, "source-task")?.label, "Message from collaborator");
  assert.equal(messageActionLabel({ ...item("reply"), name: "agent_message" }, "source-task"), undefined);
});

test("only agent messaging actions receive peer portraits and bounded split copy", () => {
  for (const name of ["user_notify", "agent_request_status", "agents_find", "files_read", "agent_inspect"]) {
    assert.equal(messageActionLabel({ ...item(name), name, request, contextName: "Researcher" }, "source-task"), undefined);
  }
  const action = { ...item("send"), name: "agent_send", arguments: { agentId: "helper" }, contextName: "Researcher\n" + "x".repeat(200) };
  const split = messageActionLabel(action, "source-task")!;
  assert.equal(split.prefix + split.name + split.suffix, actionLabel(action));
});
