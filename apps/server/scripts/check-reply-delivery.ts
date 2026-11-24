// Opt-in live evaluation. Run with: node --import tsx apps/server/scripts/check-reply-delivery.ts
// Uses the signed-in local Codex CLI, isolated SQLite workspaces and synthetic messages only.
// --round=1|2|3 chooses baseline/calibration, a fresh repeat, or reserved alternate wording.
// --case=greeting,detail selects cases. Each line of output is one complete, inspectable trial.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { AgentExecution } from "../src/agent-execution.js";
import { AgentTools } from "../src/agent-tools.js";
import { ArtifactService } from "../src/artifact-service.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import { ConnectionService } from "../src/connection-service.js";
import { openDatabase } from "../src/database.js";
import { ManagedFiles } from "../src/managed-files.js";
import { MessagingService, type MessageEnvelope } from "../src/messaging.js";
import { ProcessService } from "../src/process-service.js";
import { Vault } from "../src/vault.js";

const cases = {
  greeting: ["Say hi to Writer for me.", "Would you give Writer my regards?"],
  detail: ["What's the working title Writer picked for the next issue?", "Remind me what Writer decided to call the next edition."],
  courtesy: ["The user says hi!", "Passing along a personal hello from the user!"],
  silence: ["Tell Writer the print slot is Monday. FYI only, no reply needed.", "Let Writer know our print slot is Monday. Just an FYI; please leave it there."],
  deliverable: ["Work out the remaining print budget for me: £940 approved, £275 spent.", "Our print budget started at £940 and we spent £275. I need the amount left."],
  blocker: ["Today's print order is blocked: the print shop has cancelled the slot, and a replacement is unavailable. I need the status of the order. No decision is needed from me.", "I need to know where today's print order stands. The shop cancelled and no other slot is available today. I have no action to take."],
  routine: ["Run the routine print-slot check. The slot is confirmed and all checks are normal.", "Routine print queue monitoring: all slots are confirmed, and nothing needs attention."],
  inbox: ["What's the working title Writer picked for the next issue?", "I also need the name Writer chose for the next edition."],
} as const;
type Scenario = keyof typeof cases;
type Message = { agent: string; content: string; finished: string };
const model = "gpt-6.2-sol";
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
const allowed = new Set(["agents_find", "agent_inspect", "agent_connection_inspect", "agent_request_status", "agent_send", "agent_message", "task_set_outputs", "task_yield", "task_schedule_checkin", "task_cancel_checkin", "user_notify", "user_input_request"]);
const greeting = /\b(hi|hello|hey|regards|greetings|howdy|salutations|best wishes|my best|likewise|thanks|thank you)\b/i;
function relaysGreeting(content: string) {
  return greeting.test(content) && /\b(?:writer|they)\s+(?:says?|said|repl(?:ies|ied)|respond(?:s|ed)|sends?|returns?|wishes)|\b(?:hi|hello|greetings|regards)\s+(?:back|from writer)\b|\bfrom writer\b/i.test(content);
}

async function trial(id: Scenario, round: number) {
  const directory = await mkdtemp(join(tmpdir(), "ufai-reply-"));
  const db = openDatabase(join(directory, "fixture.sqlite"));
  const { id: workspaceId } = db.prepare("SELECT id FROM workspaces").get() as {id: string};
  const stamp = new Date().toISOString();
  const privateTitle = "Linden " + randomUUID().slice(0, 8);
  const prompt = cases[id][round === 3 ? 1 : 0];
  db.prepare("INSERT INTO connections(id,provider,name,createdAt,updatedAt,draft) VALUES ('fixture','codex','Fixture',?,?,0)").run(stamp, stamp);
  db.prepare("INSERT INTO provider_models(connectionId,id,name,manual,contextWindowOverride) VALUES ('fixture',?,?,1,200000)").run(model, model);
  db.prepare("INSERT INTO model_presets(id,name,connectionId,modelId,createdAt,updatedAt) VALUES ('preset','Fixture','fixture',?,?,?)").run(model, stamp, stamp);
  for (const [agent, role] of [["Chief", "I help the user coordinate their work."], ["Writer", "I write and edit the next issue and keep track of its working title."]]) {
    db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,presetId,createdAt,updatedAt) VALUES (?,?,?,?, 'preset',?,?)").run(agent, workspaceId, agent, role, stamp, stamp);
  }
  db.prepare("INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES (?,'Writer','Next issue working title',?,'finding','[]',?,?)")
    .run(randomUUID(), "The exact working title is " + privateTitle + ".", stamp, stamp);

  const files = new ManagedFiles(db, join(directory, "files"));
  // Keep all ufAI runtime state disposable while letting the CLI handle its own local login.
  const codex = new CodexRuntime(join(directory, "runtime"), cwd =>
    spawn(process.execPath, [cli, "app-server", "--listen", "stdio://", "-c", 'model_reasoning_effort="low"'], { cwd, stdio: ["pipe", "pipe", "pipe"] }));
  const connections = new ConnectionService(db, fetch, codex);
  const processes = new ProcessService(db, files, () => {});
  const artifacts = new ArtifactService(db, files, () => {});
  const tools = new AgentTools(db, files, processes, artifacts, () => {});
  const options = { autoStart: false };
  const engine = new AgentExecution(db, connections, options, files, tools);
  const messaging = new MessagingService(db, engine, connections);
  const vault = new Vault(db, connections.secrets, () => {});
  engine.messaging = tools.messaging = vault.messaging = messaging;
  tools.vault = vault;
  files.bind(engine);
  const dispatch = tools.dispatch.bind(tools);
  tools.dispatch = (owner, call, ...args) => allowed.has(call.name)
    ? dispatch(owner, call, ...args)
    : Promise.resolve({ok: false, error: "External or unrelated actions are unavailable in this isolated evaluation."});

  const unsettled = db.prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM agent_turns WHERE status IN ('queued','running','waiting'))
    OR EXISTS (SELECT 1 FROM agent_requests WHERE state='open')
    OR EXISTS (SELECT 1 FROM communication_deliveries WHERE state='pending')
    OR EXISTS (SELECT 1 FROM message_transits WHERE state='in_flight')`);
  const failed = db.prepare("SELECT 1 FROM agent_turns WHERE status IN ('failed','blocked') LIMIT 1");
  async function runToRest() {
    options.autoStart = true;
    engine.wake();
    const deadline = Date.now() + 120000;
    while (unsettled.get() && !failed.get() && Date.now() < deadline) await delay(150);
  }

  try {
    await files.start();
    await artifacts.start();
    tools.ready = true;
    messaging.start();
    messaging.createLink(workspaceId, "Chief", "Writer");
    let inboxSeed = "";
    if (id === "inbox") {
      // Establish the real conversation and its completion evidence before the user replies.
      const seed = engine.submit("Chief", "new", "Send me an Inbox message saying that you are ready for print questions.", randomUUID());
      await runToRest();
      const entries = db.prepare("SELECT id,content FROM workspace_inbox WHERE taskId=?").all(seed.taskId) as {id:string;content:string}[];
      assert.equal(engine.task(seed.taskId!).status, "completed", "The seed task did not complete");
      assert.equal(entries.length, 1, "The seed task should post exactly one Inbox message");
      assert.match(entries[0].content, /ready/i);
      inboxSeed = entries[0].id;
      messaging.inboxReply(inboxSeed, {content: prompt, requestId: randomUUID()});
    } else if (id === "courtesy") {
      // Start at arrival of an actual one-way notification from an already settled sender.
      const seed = engine.submit("Chief", "new", "Pass along the user's greeting.", randomUUID());
      const owner = {workspaceId, agentId: "Chief", taskId: seed.taskId!, turnId: seed.turnId};
      db.prepare("UPDATE agent_turns SET status='completed',phase='completed' WHERE id=?").run(seed.turnId);
      db.prepare("UPDATE agent_tasks SET status='completed' WHERE id=?").run(seed.taskId);
      messaging.send(owner, {agentId: "Writer", kind: "notification", content: prompt}, randomUUID());
    } else {
      const background = id === "blocker" || id === "routine";
      const envelope: MessageEnvelope = background ? {source: "system", trigger: {
        id: "scheduled-print-check", name: "Print status check", occurrenceId: randomUUID(),
        scheduledAt: stamp, dispatchedAt: stamp, lineage: ["scheduled-print-check"],
      }} : {};
      engine.submit("Chief", background || id === "deliverable" ? "new" : "chat", prompt, randomUUID(), [], "[]", envelope);
    }
    await runToRest();
    const turns = db.prepare("SELECT agentId,status,error FROM agent_turns ORDER BY rowid").all() as {agentId: string; status: string; error: string | null}[];
    const tasks = db.prepare("SELECT agentId,kind,status,pendingReason FROM agent_tasks ORDER BY rowid").all() as {agentId: string; kind: string; status: string; pendingReason: string | null}[];
    const pendingInputs = db.prepare("SELECT kind,state FROM user_input_requests WHERE state='pending'").all();
    const replies = db.prepare(`SELECT i.agentId agent,m.content,i.createdAt finished FROM execution_items i
      JOIN agent_messages m ON m.turnId=i.turnId AND m.role='assistant' AND m.state='complete'
      WHERE i.kind='final' AND trim(m.content)<>'' ORDER BY i.sequence`).all() as Message[];
    const inbox = db.prepare("SELECT agentName agent,content,userInputRequestId card FROM workspace_inbox WHERE id<>? ORDER BY sequence").all(inboxSeed) as {agent: string; content: string; card: string | null}[];
    const handoffs = db.prepare("SELECT sourceName,targetName,kind,state FROM agent_requests ORDER BY rowid").all() as {sourceName: string; targetName: string; kind: string; state: string}[];
    const results = db.prepare("SELECT senderName agent, content, createdAt finished FROM communication_messages WHERE kind='result' ORDER BY sequence").all() as Message[];
    const actions = db.prepare("SELECT name,state FROM tool_invocations ORDER BY rowid").all();
    const checkpoints = db.prepare(`SELECT m.content FROM agent_messages m JOIN agent_turns t ON t.id=m.turnId
      WHERE m.role='assistant' AND m.state='complete' AND trim(m.content)<>''
      AND NOT EXISTS (SELECT 1 FROM execution_items i WHERE i.turnId=t.id AND i.kind='final') ORDER BY m.sequence`).all();
    const exchange = db.prepare("SELECT kind,senderName,content,createdAt FROM communication_messages ORDER BY sequence").all();
    const failures: string[] = [];
    function check(ok: boolean, reason: string) { if (!ok) failures.push(reason); }
    check(!unsettled.get(), "Unfinished exchange");
    check(turns.every(t => t.status === "completed"), "A turn failed or remained unfinished");
    check(tasks.every(t => t.status === "completed" && !t.pendingReason) && !pendingInputs.length,
      "A task did not complete or still has an outstanding dependency or user input");
    const chief = replies.filter(r => r.agent === "Chief");
    const writer = replies.filter(r => r.agent === "Writer");
    const oneRequest = handoffs.length === 1 && handoffs[0].kind === "request" && handoffs[0].state === "completed" && handoffs[0].sourceName === "Chief" && handoffs[0].targetName === "Writer";
    const oneNotification = handoffs.length === 1 && handoffs[0].kind === "notification" && handoffs[0].state === "completed" && handoffs[0].sourceName === "Chief" && handoffs[0].targetName === "Writer";
    if (id === "greeting") {
      const received = results.find(r => r.agent === "Writer" && greeting.test(r.content));
      const relays = chief.filter(r => relaysGreeting(r.content));
      check(oneRequest && !!received, "No completed request with Writer's actual greeting");
      check(relays.length === 1 && !!received && relays[0].finished >= received.finished, "Chief did not return the greeting exactly once after receiving it");
      check(inbox.length === 0, "Unexpected Inbox delivery");
    } else if (id === "detail" || id === "inbox") {
      const result = results.find(r => r.agent === "Writer" && r.content.includes(privateTitle));
      check(oneRequest && !!result && writer.some(r => r.content.includes(privateTitle)), "Missing the actual result from Writer's private record");
      if (id === "detail") {
        const matches = chief.filter(r => r.content.includes(privateTitle));
        check(matches.length === 1 && !!result && matches[0].finished >= result.finished && !inbox.length, "Private title did not reach Chat exactly once");
      } else {
        check(inbox.length === 1 && inbox[0].agent === "Chief" && inbox[0].content.includes(privateTitle) && !inbox[0].card, "Expected exactly one Inbox reply with the verified title");
      }
    } else if (id === "silence") {
      check(oneNotification && !results.length && !inbox.length && chief.every(r => !relaysGreeting(r.content) && !/\bwriter\s+(?:confirmed|acknowledged|responded|replied|told me)\b/i.test(r.content)), "Explicit FYI generated a reply or alert, or never reached Writer as a notification");
    } else if (id === "courtesy") {
      check(oneNotification && !results.length && inbox.length === 1 && inbox[0].agent === "Writer" && !inbox[0].card && greeting.test(inbox[0].content), "Writer's personal reply did not reach Inbox exactly once");
    } else if (id === "routine") {
      check(!inbox.length, "Uneventful scheduled work alerted the user");
    } else {
      const expected = id === "deliverable" ? /\b665\b/ : /cancel|block|unavailable|cannot|can.t|no (?:other|available|replacement)/i;
      check(inbox.length === 1 && inbox[0].agent === "Chief" && !inbox[0].card && expected.test(inbox[0].content), "Expected one informative Inbox outcome with no duplicate card");
    }
    return {id, round, model, prompt, passed: !failures.length, failures, handoffs, exchange, results, replies, checkpoints, inbox, tasks, pendingInputs, turns, actions};
  } finally {
    await engine.close();
    await messaging.close();
    vault.close();
    await processes.close();
    await artifacts.close();
    await connections.close();
    await files.close();
    db.close();
    await rm(directory, {recursive: true, force: true});
  }
}

const {values} = parseArgs({options: {round: {type: "string", default: "1"}, case: {type: "string"}}});
const round = Number(values.round);
assert.ok([1,2,3].includes(round), "--round must be 1, 2 or 3");
const selected = values.case?.split(",") ?? Object.keys(cases);
assert.ok(selected.length && selected.every(id => Object.hasOwn(cases, id)), "Unknown case");
for (let i = 0; i < selected.length; i += 2) {
  await Promise.all(selected.slice(i, i + 2).map(async key => {
    try {
      const result = await trial(key as Scenario, round);
      console.log(JSON.stringify(result));
      if (!result.passed) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({id: key, round, passed: false, error: String(error)}));
      process.exitCode = 1;
    }
  }));
}
