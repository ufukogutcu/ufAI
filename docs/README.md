# ufAI agent documentation

This directory is the repository's shared project reference for AI agents. It explains what ufAI can currently do, what is intended, and where to verify implementation details. It is not a live inventory of a user's machine or workspaces.

## Reading paths

| Audience or task | Read |
| --- | --- |
| Coding agent starting work | Root [AGENTS.md](../AGENTS.md), this index, then relevant sections of the [architecture reference](architecture.md) and [platform guide](platform.md) |
| Future in-app assistant helping a user | [Platform guide](platform.md); consult architecture only when a technical detail is necessary |
| Setup, startup, configuration, or troubleshooting | [Platform operations](platform.md#implemented-capabilities) and [configuration](architecture.md#configuration) |
| HTTP payloads, errors, and persistence-backed UI APIs | [HTTP API reference](api.md), [architecture reference](architecture.md) |
| Provider, agent, workspace, or trigger development | [Product direction](platform.md#planned-capabilities) and [extension boundaries](architecture.md#extension-boundaries) |

Read relevant sections instead of loading all documents on every task. Follow their links to source when implementation truth is needed. If documentation conflicts with current code, inspect the discrepancy, repair the affected documentation alongside the task, and do not silently invent behavior.

The in-app assistant is planned. These Markdown documents are not currently bundled into the application, indexed for retrieval, or connected to an assistant. Reading them does not grant permission to execute actions; actual permissions, available tools, and current application state remain authoritative.

## Terminology

These are intended product concepts unless explicitly marked as implemented in the platform guide.

| Term | Meaning |
| --- | --- |
| Workspace | A logical grouping of agents, communication rules, configuration, and resources |
| Agent | A persistent configured identity with instructions, skills, selected model/runtime, permissions, and its own working space |
| Model provider | An inference service or local endpoint; ufAI would own the surrounding agent loop |
| Agent runtime | An existing execution system with its own agent loop, sessions, tools, and possibly approvals |
| Session | A conversation or task context belonging to an agent |
| Run | One execution with status, events, results, and any approvals |
| Connection | An intended permission to communicate between agents; not automatically an execution dependency |
| Skill | Reusable instructions and optional resources/tools available to an agent; not an independent permission grant |
| Trigger | A source of work such as a manual action, schedule, webhook, or custom event |

## Status vocabulary

- **`implemented`:** The described behavior exists in the current repository. State its limits; existence does not imply production readiness.
- **`partial`:** A capability has working parts but is incomplete. List the available behavior and missing parts explicitly.
- **`planned`:** Product direction only. Do not instruct users to use it or invent screens, commands, credentials, or endpoints for it.

These statuses describe software capability, not whether a particular local server is running. A build succeeding does not prove a product feature exists.

## Document format

- Use Markdown, descriptive headings, short direct statements, and relative links within the repository.
- Keep capability IDs stable, lowercase, and hyphenated. Use the ID as a heading for available capabilities and as an explicit ID column for planned entries. Retain IDs through display-name changes; document replacements when a capability is retired or split.
- Use this capability entry format; omit inapplicable fields instead of fabricating content:

```markdown
### capability-id

- **Status:** implemented | partial | planned
- **Purpose:** What this enables.
- **Prerequisites:** Required software, configuration, permissions, or earlier steps.
- **Behavior / steps:** Verified behavior and actions; for planned entries, label intentions explicitly and omit operational steps.
- **Limitations:** Missing behavior, constraints, and relevant failure conditions.
- **Related references:** Links to related capabilities, architecture, or source.
```

Planned entries may use a compact table with the same applicable fields. Keep known limitations near the behavior they qualify. Configuration and public interfaces belong in the architecture reference; the platform guide links to them rather than duplicating their complete definitions.

Record current engineering decisions with a short rationale and label future direction separately. Avoid copying function implementations, maintaining redundant package-version inventories, recording conversation transcripts, or adding status dates that will become stale. Package manifests and the lockfile remain the dependency-version source of truth.

## Maintenance checklist

For every change, the coding agent must:

1. Identify affected capability IDs and whether behavior, setup, permissions, configuration, interfaces, persistence, or limitations changed.
2. Update the platform guide for user-visible behavior and the architecture reference for implementation changes in the same change as the code. Update `AGENTS.md` only when lasting working rules or shared project context change.
3. Change statuses only after the described behavior exists and has been appropriately checked. Mark partial implementations honestly; do not carry forward obsolete future-only descriptions.
4. Update navigation, relative links, examples, and cross-references when documents or features move. Remove stale and contradictory guidance. Add a focused document and index link when a topic outgrows a short section.
5. Check facts against source and manifests. Validate referenced commands, API shapes, defaults, and limitations; run behavior checks only as needed to resolve uncertainty.
6. Keep secrets, private agent/user data, machine-specific logs, and current PIDs out of documentation. Use safe placeholders for examples.
7. Summarize documentation updates in the task result, or briefly explain why documentation did not need changing. Report actual validation and remaining gaps.

Documentation-only work needs link, consistency, and whitespace checks; it does not require new runtime tests or application changes.
