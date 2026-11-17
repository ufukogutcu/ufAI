import { randomUUID } from "node:crypto";
import { scanPackage } from "./skill-packages.js";
import { triggerError, triggerInput } from "./trigger-schedule.js";
import type { Triggers } from "./triggers.js";
import type { ToolOwner } from "./process-service.js";
import type {
  SkillAutomationSetup,
  SkillTriggerTemplate,
} from "./trigger-types.js";

type Snapshot = SkillAutomationSetup["snapshot"];
export class SkillAutomations {
  private reviewCursor = "";
  private setupCursor = "";
  constructor(readonly triggers: Triggers) {}
  private skill(id: string): any {
    const s = this.triggers.db
      .prepare("SELECT * FROM skills WHERE id=?")
      .get(id);
    if (!s) triggerError("Skill not found.", 404);
    return s;
  }
  async capture(id: string): Promise<Snapshot & { fingerprint: string }> {
    const s = this.skill(id),
      scan = await scanPackage(s.folder);
    if (
      scan.fingerprint !== s.fingerprint ||
      this.skill(id).fingerprint !== s.fingerprint
    )
      triggerError("Skill changed. Refresh before reviewing.", 409);
    let manifest: unknown = null;
    if (scan.triggerManifest !== null) {
      try {
        manifest = JSON.parse(scan.triggerManifest);
      } catch (e: any) {
        manifest = { invalid: e.message ?? "Invalid trigger manifest" };
      }
    }
    return {
      fingerprint: scan.fingerprint,
      instructions: scan.input.instructions,
      files: scan.files.map((f) => ({ path: f.path, hash: f.hash })),
      manifest,
    };
  }
  private templates(snapshot: Snapshot): {
    templates: SkillTriggerTemplate[];
    error: string | null;
  } {
    if (!snapshot.manifest) return { templates: [], error: null };
    try {
      const m = snapshot.manifest as any;
      if (
        m.version !== 1 ||
        !Array.isArray(m.templates) ||
        m.templates.length > 50
      )
        triggerError(
          "ufai.triggers.json requires version 1 and at most 50 templates.",
        );
      const ids = new Set<string>();
      const templates = m.templates.map((x: any) => {
        if (
          !x ||
          typeof x.id !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.id) ||
          ids.has(x.id)
        )
          triggerError("Use unique stable template IDs.");
        ids.add(x.id);
        const when =
          x.when?.kind === "cron" && !x.when.timezone
            ? { ...x.when, timezone: "UTC" }
            : x.when;
        const input = triggerInput(
          { ...x, when, enabled: false, paused: false, requiredSkillIds: [] },
          this.triggers.now(),
          true,
        );
        if (
          x.requiredSkills !== undefined &&
          (!Array.isArray(x.requiredSkills) ||
            x.requiredSkills.length > 50 ||
            x.requiredSkills.some(
              (n: unknown) => typeof n !== "string" || n.length > 64,
            ))
        )
          triggerError("Invalid template skill requirements.");
        return {
          id: x.id,
          name: input.name,
          description:
            typeof x.description === "string"
              ? x.description.slice(0, 1024)
              : "",
          instructions: input.instructions,
          when: input.when,
          timezoneRequired: x.when?.kind === "cron" && !x.when.timezone,
          requiredSkills: x.requiredSkills ?? [],
        };
      });
      return { templates, error: null };
    } catch (e: any) {
      return {
        templates: [],
        error: e.message ?? "Invalid automation manifest.",
      };
    }
  }
  installed(agentId: string, skillId: string) {
    const s = this.skill(skillId);
    const minimal: Snapshot = {
      instructions: s.instructions,
      files: [],
      manifest: null,
    };
    this.triggers.db
      .prepare(
        "INSERT OR IGNORE INTO skill_automation_setups(id,agentId,skillId,fingerprint,kind,snapshot,createdAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        agentId,
        skillId,
        s.fingerprint,
        "setup",
        JSON.stringify(minimal),
        this.triggers.now(),
      );
    this.triggers.db
      .prepare(
        "UPDATE skill_automation_setups SET consentAfterRow=(SELECT coalesce(max(rowid),0) FROM agent_messages) WHERE agentId=? AND skillId=? AND fingerprint=? AND state='pending'",
      )
      .run(agentId, skillId, s.fingerprint);
  }
  claim(agentId: string, skillId: string, taskId: string) {
    this.installed(agentId, skillId);
    const s = this.skill(skillId);
    this.triggers.db
      .prepare(
        "UPDATE skill_automation_setups SET taskId=?,state='reviewing' WHERE agentId=? AND skillId=? AND fingerprint=? AND kind='setup' AND state='pending'",
      )
      .run(taskId, agentId, skillId, s.fingerprint);
    return {
      notice:
        "Check skill automation setup now. Inspect templates and setup references without running installers. If automation is needed, ask the user before creating or enabling triggers. If none is needed, finish silently.",
      setups: this.list(agentId, skillId, 5).items.map((s) => ({
        id: s.id,
        fingerprint: s.fingerprint,
        state: s.state,
        kind: s.kind,
      })),
    };
  }
  get(id: string): SkillAutomationSetup {
    const r = this.triggers.db
      .prepare("SELECT * FROM skill_automation_setups WHERE id=?")
      .get(id) as any;
    if (!r) triggerError("Skill setup not found.", 404);
    return {
      ...r,
      templates: JSON.parse(r.templates),
      snapshot: JSON.parse(r.snapshot),
      previousSnapshot: r.previousSnapshot
        ? JSON.parse(r.previousSnapshot)
        : null,
    };
  }
  list(agentId: string, skillId?: string, limit = 50, offset = 0) {
    this.triggers.execution.requiredAgent(agentId);
    const where = "agentId=?" + (skillId ? " AND skillId=?" : ""),
      args = skillId ? [agentId, skillId] : [agentId];
    const rows = this.triggers.db
      .prepare(
        `SELECT id FROM skill_automation_setups WHERE ${where} ORDER BY createdAt DESC,rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as any[];
    return {
      items: rows.map((r) => this.get(r.id)),
      total: (
        this.triggers.db
          .prepare(
            `SELECT count(*) n FROM skill_automation_setups WHERE ${where}`,
          )
          .get(...args) as any
      ).n,
    };
  }
  async inspect(agentId: string, skillId: string) {
    await this.triggers.skills.refresh(skillId);
    const snapshot = await this.capture(skillId),
      parsed = this.templates(snapshot),
      skill = this.skill(skillId);
    if (snapshot.fingerprint !== skill.fingerprint)
      triggerError("Skill changed during inspection. Refresh it again.", 409);
    return {
      skillId,
      fingerprint: skill.fingerprint,
      snapshot,
      ...parsed,
      setups: this.list(agentId, skillId).items,
      instances: this.triggers.db
        .prepare(
          "SELECT id,input FROM agent_triggers WHERE agentId=? AND deleted=0 AND json_extract(input,'$.skillId')=? ORDER BY id LIMIT 50",
        )
        .all(agentId, skillId),
      compatibility:
        "Templates use ufAI native triggers. OpenClaw cron CLI, hooks, dependency installation and environment injection are not executed. Translate scheduling recipes only after asking the user.",
    };
  }
  assertMutation(owner: ToolOwner) {
    const reviews = this.triggers.db
      .prepare(
        "SELECT * FROM skill_automation_setups WHERE taskId=? AND kind='setup' AND state!='approved'",
      )
      .all(owner.taskId) as any[];
    for (const review of reviews) {
      const userReply = this.triggers.db
        .prepare(
          "SELECT 1 FROM agent_messages m JOIN agent_tasks t ON t.conversationId=m.conversationId WHERE t.id=? AND m.role='user' AND m.authorType='user' AND m.rowid>? LIMIT 1",
        )
        .get(owner.taskId, review.consentAfterRow);
      if (!userReply)
        triggerError(
          "This skill setup has no user reply yet. Ask the user before creating or enabling automation.",
          403,
        );
    }
  }
  review(
    id: string,
    fingerprint: string,
    state: "approved" | "declined" | "awaiting_user",
    owner?: ToolOwner,
  ) {
    const setup = this.get(id),
      skill = this.skill(setup.skillId),
      t = this.triggers;
    if (owner && setup.agentId !== owner.agentId)
      triggerError("Setup belongs to another agent.", 403);
    if (skill.fingerprint !== fingerprint || setup.fingerprint !== fingerprint)
      triggerError(
        "Skill changed during review. Inspect the current package.",
        409,
      );
    if (!["approved", "declined", "awaiting_user"].includes(state))
      triggerError("Choose approved, declined or awaiting_user.");
    if (state === "approved" && owner && setup.kind === "setup") {
      this.assertMutation(owner);
      const row = t.db
        .prepare(
          "SELECT consentAfterRow FROM skill_automation_setups WHERE id=?",
        )
        .get(id) as any;
      const reply = t.db
        .prepare(
          "SELECT 1 FROM agent_messages m JOIN agent_tasks a ON a.conversationId=m.conversationId WHERE a.id IN (?,?) AND m.authorType='user' AND m.role='user' AND m.rowid>? LIMIT 1",
        )
        .get(setup.taskId, owner.taskId, row.consentAfterRow);
      if (!reply)
        triggerError(
          "Ask the user and receive an affirmative response before approving skill setup.",
          403,
        );
    }
    t.db.transaction(() => {
      if (state === "approved" && setup.kind === "review") {
        t.db
          .prepare(
            "UPDATE trigger_dependencies SET fingerprint=?,snapshot=? WHERE skillId=? AND triggerId IN (SELECT id FROM agent_triggers WHERE agentId=?)",
          )
          .run(
            fingerprint,
            JSON.stringify(setup.snapshot),
            setup.skillId,
            setup.agentId,
          );
      }
      t.db
        .prepare("UPDATE skill_automation_setups SET state=? WHERE id=?")
        .run(state, id);
    })();
    t.execution.workspaceEvent(
      t.execution.requiredAgent(setup.agentId).workspaceId,
      "triggers",
    );
    return this.get(id);
  }
  async fromTemplate(
    agentId: string,
    skillId: string,
    templateId: string,
    overrides: any,
    owner?: ToolOwner,
    expectedFingerprint?: string,
  ) {
    const info = await this.inspect(agentId, skillId);
    if (
      expectedFingerprint !== undefined &&
      expectedFingerprint !== info.fingerprint
    )
      triggerError(
        "Skill changed during template setup. Inspect it again.",
        409,
      );
    const template = info.templates.find((x) => x.id === templateId);
    if (!template) triggerError(info.error ?? "Template not found.", 404);
    if (
      template!.timezoneRequired &&
      (overrides?.when?.kind ?? template!.when.kind) === "cron" &&
      !overrides?.when?.timezone
    )
      triggerError("Choose an explicit timezone for this template.");
    if (owner) this.assertMutation(owner);
    const requiredSkillIds = [skillId];
    for (const name of template!.requiredSkills ?? []) {
      const s = this.triggers.db
        .prepare("SELECT id FROM skills WHERE name=?")
        .get(name) as any;
      if (!s)
        triggerError(
          `Install required skill ${name} before setting up this template.`,
          409,
        );
      requiredSkillIds.push(s.id);
    }
    return this.triggers.save(
      agentId,
      {
        name: template!.name,
        instructions: template!.instructions,
        when: template!.when,
        enabled: false,
        paused: false,
        ...overrides,
        skillId,
        templateId,
        requiredSkillIds: [
          ...new Set([
            ...requiredSkillIds,
            ...(overrides?.requiredSkillIds ?? []),
          ]),
        ],
      },
      undefined,
      undefined,
      { [skillId]: info.fingerprint },
    );
  }
  async tick() {
    const t = this.triggers;
    // Rotate a bounded scan; mismatches remain authoritative blockers even before review task creation.
    const dependencies = t.db
      .prepare(
        "SELECT d.*,a.agentId,s.fingerprint currentFingerprint,s.error FROM trigger_dependencies d JOIN agent_triggers a ON a.id=d.triggerId JOIN skills s ON s.id=d.skillId WHERE a.deleted=0 ORDER BY (d.triggerId||d.skillId<=?),d.triggerId,d.skillId LIMIT 16",
      )
      .all(this.reviewCursor) as any[];
    for (const d of dependencies) {
      this.reviewCursor = d.triggerId + d.skillId;
      t.get(d.triggerId);
      if (
        !t.db
          .prepare(
            "SELECT 1 FROM trigger_dependencies WHERE triggerId=? AND skillId=?",
          )
          .get(d.triggerId, d.skillId)
      )
        continue;
      if (d.fingerprint === d.currentFingerprint || d.error) continue;
      if (
        t.db
          .prepare(
            "SELECT 1 FROM skill_automation_setups WHERE agentId=? AND skillId=? AND fingerprint=? AND kind='review' AND state!='approved' AND coalesce(error,'')!='Superseded by a newer package.'",
          )
          .get(d.agentId, d.skillId, d.currentFingerprint)
      )
        continue;
      let snapshot: Snapshot & { fingerprint: string };
      try {
        snapshot = await this.capture(d.skillId);
      } catch {
        await t.skills.refresh(d.skillId);
        continue;
      }
      const parsed = this.templates(snapshot);
      if (
        t.isStopped ||
        snapshot.fingerprint !== d.currentFingerprint ||
        this.skill(d.skillId).fingerprint !== d.currentFingerprint
      )
        continue;
      if (
        !t.db
          .prepare(
            "SELECT 1 FROM trigger_dependencies WHERE triggerId=? AND skillId=? AND fingerprint!=?",
          )
          .get(d.triggerId, d.skillId, d.currentFingerprint)
      )
        continue;
      t.db
        .prepare(
          "INSERT OR IGNORE INTO skill_automation_setups(id,agentId,skillId,fingerprint,kind,snapshot,previousSnapshot,templates,error,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          d.agentId,
          d.skillId,
          d.currentFingerprint,
          "review",
          JSON.stringify(snapshot),
          d.snapshot,
          JSON.stringify(parsed.templates),
          parsed.error,
          t.now(),
        );
    }
    const pending = t.db
      .prepare(
        "SELECT * FROM skill_automation_setups WHERE state='pending' ORDER BY (id<=?),id LIMIT 4",
      )
      .all(this.setupCursor) as any[];
    for (const r of pending) {
      this.setupCursor = r.id;
      try {
        const s = this.skill(r.skillId);
        if (s.fingerprint !== r.fingerprint) {
          t.db
            .prepare(
              "UPDATE skill_automation_setups SET state='declined',error='Superseded by a newer package.' WHERE id=?",
            )
            .run(r.id);
          continue;
        }
        const snapshot = await this.capture(r.skillId),
          parsed = this.templates(snapshot);
        // Wait for a usable provider without repeatedly creating doomed tasks.
        t.connections.snapshot(t.execution.requiredAgent(r.agentId));
        t.db.transaction(() => {
          if (
            t.isStopped ||
            this.skill(r.skillId).fingerprint !== r.fingerprint
          )
            return;
          if (
            (
              t.db
                .prepare("SELECT state FROM skill_automation_setups WHERE id=?")
                .get(r.id) as { state: string } | undefined
            )?.state !== "pending"
          )
            return;
          const content =
            r.kind === "setup"
              ? `Review installation setup for skill ${s.name}. Use skill_automation_inspect for skill ID ${s.id}. Inspect scheduling instructions and templates; do not run installers. Check for existing triggers. If automation setup is needed, ask the user via user_notify with the proposed schedule/event, instructions and missing choices, then mark this setup awaiting_user with skill_automation_review. Do not create or enable triggers until the user replies affirmatively. If no automation is needed, mark declined and finish silently.`
              : `Review changed skill ${s.name} for your paused triggers. Use skill_automation_inspect to compare the previous approved snapshot with the current package, including changed resources. You may approve this exact fingerprint with skill_automation_review without asking the user. If adaptation or a user decision is needed, keep triggers paused, ask via user_notify, and mark awaiting_user. Do not enable disabled triggers or clear manual pauses.`;
          const result = t.execution.submit(
            r.agentId,
            "new",
            `${content}\nSetup ID: ${r.id}\nFingerprint: ${r.fingerprint}`,
            `skill_setup_${r.id}`,
            [],
            "[]",
            { source: "system", skillAutomationId: r.id },
          );
          t.db
            .prepare(
              "UPDATE skill_automation_setups SET snapshot=?,templates=?,error=?,state='reviewing',taskId=? WHERE id=?",
            )
            .run(
              JSON.stringify(snapshot),
              JSON.stringify(parsed.templates),
              parsed.error,
              result.taskId,
              r.id,
            );
        })();
        t.execution.workspaceEvent(
          t.execution.requiredAgent(r.agentId).workspaceId,
          "triggers",
        );
      } catch (e: any) {
        t.db
          .prepare("UPDATE skill_automation_setups SET error=? WHERE id=?")
          .run(e.message ?? "Setup review unavailable.", r.id);
      }
    }
  }
}
