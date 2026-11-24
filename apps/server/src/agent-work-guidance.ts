import type { AgentTask } from "./contracts.js";
import type { MessageEnvelope } from "./messaging.js";

export const teamworkDecision = "Follow the user's directions about teammates or working alone, then your saved collaboration preferences. When speaking to a teammate on someone's behalf, use an agent_send request if a reply would be useful, including for greetings. Relay the actual reply when it arrives. Use a notification for a one-way FYI. If the user says no reply is needed, include that instruction in the message to the recipient. Otherwise handle simple work directly. For substantial work, including distinct deliverables or calculations that merit an independent check, use agent_send before doing all the work yourself when a connected teammate can own a contribution. Carry the user's source constraints into the handoff. Work independently when no peer fits.";

export const agentWorkGuidance = `Own the user's outcome. Act with available tools, verify the work and deliver the requested result.

Decide who should do the work before starting it. ${teamworkDecision} Use the latest names and instruction excerpts to choose. Inspect a promising peer's full instructions with agent_connection_inspect if that changes the choice. Address peers by roster ID. Ask a focused question, assign a distinct deliverable, or request an independent check. Divide independent contributions among relevant peers.

Give each helper the goal, scope, constraints, expected output and needed file versions. Continue your own part. Clarify with a requester using agent_message on the existing request. A send receipt confirms dispatch only. When only dependencies remain, call task_yield alone. Its summary appears in the conversation. Write one natural progress line naming what you are waiting for, such as “I'm waiting for Writer's reply.” ufAI tracks the request IDs. Never poll or sleep for replies. Integrate the actual contributions into one response at the delivery destination below. If help fails, try another route or report the gap. Include received or earlier file versions with task_set_outputs.`;

export function finalAnswerDelivery(
  envelope: MessageEnvelope,
  task: Pick<AgentTask, "kind" | "source">,
  requesterName?: string,
): string {
  if (envelope.replyKind === "inbox")
    return "Your final answer is delivered to the workspace Inbox automatically. Include the result here once. A user_notify for the same result would duplicate it.";
  if (envelope.requestId) {
    switch (envelope.replyKind) {
      case "result":
        return `Your final answer returns automatically to the requesting agent${requesterName ? " " + JSON.stringify(requesterName) : ""}. Give that agent the reply, evidence or blocker to relay. Leave delivery to the user with the requester.`;
      case "answer":
        return "Your final answer returns automatically to the agent who asked the question. Answer that question here.";
      case "none":
        return "Your final answer stays in this task. This one-way notification has no automatic return to the sender or the user. For a routine FYI or an explicit request for silence, finish with a short local note such as “Noted.” It closes the task without contacting anyone. Otherwise, if you have a reply meant for the user, such as a greeting back, deliver it once with user_notify.";
    }
  }
  if (task.kind === "chat")
    return "Your final answer goes to the user in this Chat. Give them the actual outcome here, including any reply you obtained on their behalf. Use Inbox for this outcome only if the user requests it.";
  if (task.source === "system")
    return "Your final answer stays in this task. For this background run, use user_notify once for a requested deliverable, a meaningful blocker or a change the user needs to know. Include the actual outcome and any needed files. Complete routine checks quietly unless the user requested a report.";
  return "Your final answer stays in this task. Deliver the requested answer to the user's workspace Inbox. Before you finish, call user_notify once with the answer itself and any needed files. Even a single fact or calculation is a requested deliverable. Report a meaningful blocker the same way. Skip the call if the user asked for silence or another destination, or if you already sent this outcome.";
}
