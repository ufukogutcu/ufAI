import type Database from "better-sqlite3";

type ToolEvidence = {
  turnId: string;
  callId: string;
  name: string;
  currentTurn: boolean;
  createdAt: string;
  state: string;
  arguments?: unknown;
  result: unknown;
  truncated: boolean;
};

// Evidence is context for retrospective classification, never instructions or
// additional memory-source authority. Keep file contents, logs and collections bounded.
function excerpt(
  value: unknown,
  changed: { value: boolean },
  depth = 0,
): unknown {
  if (typeof value === "string") {
    if (value.length <= 400) return value;
    changed.value = true;
    return value.slice(0, 400) + " [truncated]";
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) {
    changed.value = true;
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    if (value.length > 6) changed.value = true;
    return value.slice(0, 6).map((item) => excerpt(item, changed, depth + 1));
  }
  const entries = Object.entries(value);
  if (entries.length > 16) changed.value = true;
  return Object.fromEntries(
    entries
      .slice(0, 16)
      .map(([key, item]) => [key, excerpt(item, changed, depth + 1)]),
  );
}

export function maintenanceEvidence(
  db: Database.Database,
  taskId: string,
  turnId: string,
  inputMessageId: string,
  continuation: boolean,
  contextWindow: number,
) {
  const byteBudget = Math.max(
    512,
    Math.min(12000, Math.floor(contextWindow / 5)),
  );
  const processRows = db
    .prepare(
      `SELECT id,state,exitCode,signal,substr(error,1,160) AS error FROM owned_processes
    WHERE taskId=? ORDER BY (state IN ('starting','running')) DESC,createdAt DESC,id LIMIT 9`,
    )
    .all(taskId) as {
    id: string;
    state: string;
    exitCode: number | null;
    signal: string | null;
    error: string | null;
  }[];
  const processes: typeof processRows = [];
  let processBytes = 0;
  for (const process of processRows.slice(0, 8)) {
    const size = Buffer.byteLength(JSON.stringify(process));
    if (processBytes + size > Math.min(2000, Math.floor(byteBudget / 4))) break;
    processes.push(process);
    processBytes += size;
  }
  // The task/sequence index bounds the activity scan. The invocation journal is
  // authoritative for matching arguments/outcomes; never infer success from a call alone.
  const rows = db
    .prepare(
      `SELECT e.turnId,e.createdAt,t.inputMessageId,v.callId,v.name,v.arguments,v.result,v.state
    FROM (SELECT turnId,createdAt,sequence,content FROM execution_items WHERE taskId=? AND kind='tool_result' ORDER BY sequence DESC LIMIT 33) e
    JOIN agent_turns t ON t.id=e.turnId
    JOIN tool_invocations v ON v.turnId=e.turnId
      AND v.callId=CASE WHEN json_valid(e.content) THEN json_extract(e.content,'$.callId') END
    ORDER BY e.sequence DESC`,
    )
    .all(taskId) as {
    turnId: string;
    createdAt: string;
    inputMessageId: string;
    callId: string;
    name: string;
    arguments: string;
    result: string | null;
    state: string;
  }[];
  const tools: ToolEvidence[] = [];
  let truncated = rows.length > 32;
  let used = 0;
  for (const row of rows.slice(0, 32)) {
    if (!continuation && row.inputMessageId !== inputMessageId) continue;
    const changed = { value: false };
    const args = JSON.parse(row.arguments) as Record<string, unknown>;
    // Environment values and terminal input are unnecessary for judging completion.
    const { env: _env, ...safeArgs } = args;
    if (row.name === "process_input") delete safeArgs.data;
    const result = row.result
      ? JSON.parse(row.result)
      : { ok: false, error: "No committed tool outcome." };
    const item: ToolEvidence = {
      turnId: row.turnId,
      callId: row.callId,
      name: row.name,
      currentTurn: row.turnId === turnId,
      createdAt: row.createdAt,
      state: row.state,
      arguments: excerpt(safeArgs, changed),
      result: excerpt(result, changed),
      truncated: changed.value,
    };
    if (Buffer.byteLength(JSON.stringify(item)) > 2048) {
      item.arguments = undefined;
      item.result = excerpt(result, { value: false }, 3);
      item.truncated = true;
    }
    const size = Buffer.byteLength(JSON.stringify(item));
    if (used + size > byteBudget - processBytes - 128) {
      truncated = true;
      break;
    }
    tools.push(item);
    used += size;
  }
  return {
    tools: tools.reverse(),
    truncated,
    processes,
    processesTruncated: processRows.length > processes.length,
  };
}
