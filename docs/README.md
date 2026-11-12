# Knowledge for ufAI app agents

This folder contains product knowledge for AI agents inside ufAI that help users understand and use the application. It explains the app's purpose, available features, common workflows, and limitations. It is not developer documentation, coding-agent instructions, an engineering reference, or a design manual.

Read the [platform guide](platform.md) to answer questions about workspaces, the flowboard, Agent Presets, Providers, model testing, sign-in, themes, and saved data. Its [common questions](platform.md#common-questions) explain frequent points of confusion, and its [planned capabilities](platform.md#planned-capabilities) distinguish future ideas from available features.

The built-in assistant and agent execution are not currently available. These documents prepare app knowledge; their existence does not automatically load them into an agent or connect an assistant. They also do not reveal the user's current connections, credentials, workspaces, or running sessions. Documentation is context, not permission to act on user resources.

## Terminology

Some terms describe planned capabilities. Check the platform guide before presenting them as available.

| Term | Meaning |
| --- | --- |
| Workspace | A grouping for related agents and work; currently a name, optional description, and empty flowboard |
| Flowboard | The visual board belonging to a workspace |
| Agent Preset | A named reusable configuration with optional saved Provider/model choices and compaction settings |
| Model provider | A service or local endpoint offering model access; ufAI supports connection setup, model discovery, shared model context windows, and short prompt tests; general inference is unavailable |
| Agent runtime | An existing agent system such as Codex; ufAI currently supports Codex sign-in, model discovery, and short prompt tests; general agent execution is unavailable |
| Provider | A named saved service/account/endpoint configuration with at least one model; Agent Presets select from these records |
| Agent | A planned configured identity with instructions, skills, a model/runtime, and permissions |
| Agent communication connection | A planned permission for agents to communicate; different from a saved provider account |
| Session | A planned conversation or task context belonging to an agent |
| Run | A planned execution of agent work with progress and results |
| Skill | Reusable instructions and supporting resources; not an independent permission grant |
| Trigger | A planned source of work such as a manual action, schedule, or webhook |

## Feature status

- **Implemented:** Available as described, subject to the stated limitations.
- **Partial:** Some parts work; the guide identifies what remains unavailable.
- **Planned:** Not available yet. Plans are not a release schedule or a promise of current support.

Feature status does not establish whether the user's local installation is running, a connection is signed in, or a particular account can access a model.
