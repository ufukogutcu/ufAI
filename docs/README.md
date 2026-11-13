# Knowledge for ufAI app agents

This folder contains product knowledge for AI agents inside ufAI that help users understand and use the application. It explains the app's purpose, available features, common workflows, and limitations. It is not developer documentation, coding-agent instructions, an engineering reference, or a design manual.

Read the [platform guide](platform.md) to answer questions about workspaces, Clusters, managed folders, the flowboard, Agent Presets, Providers, model testing, sign-in, subscription usage and earned resets, themes, and saved data. Its [common questions](platform.md#common-questions) explain frequent points of confusion, and its [planned capabilities](platform.md#planned-capabilities) distinguish future ideas from available features.

Agent execution, host tools, terminal sessions, composer attachments, native image/PDF inputs on supported models, and published files are available; the built-in platform assistant is not. These documents prepare app knowledge; their existence does not automatically load them into an agent or connect an assistant. They also do not reveal the user's current connections, credentials, workspaces, or running sessions. Documentation is context, not permission to act on user resources.

## Terminology

Some terms describe planned capabilities. Check the platform guide before presenting them as available.

| Term | Meaning |
| --- | --- |
| Workspace | A grouping for related agents and work; currently a name, optional description, and agent flowboard |
| Cluster | A department inside one workspace, with a shared folder; an agent belongs to at most one Cluster |
| Managed folder | A ufAI-created working location whose path can be copied; agents can use it through file and command tools; folders do not isolate host access |
| Flowboard | The visual board belonging to a workspace |
| Agent Preset | A named reusable configuration with optional saved Provider/model choices and compaction settings |
| Model provider | A service or local endpoint offering model access; ufAI supports connection setup, model discovery, shared model context windows, and short prompt tests; task inference with tools where the selected model supports them is supported through Agent Presets |
| Agent runtime | An existing agent system such as Codex; ufAI currently supports Codex sign-in, model discovery, subscription usage and earned resets, and short prompt tests; task conversations with ufAI-managed tools are supported |
| Provider | A named saved service/account/endpoint configuration with at least one model; Agent Presets select from these records |
| Agent | A persistent workspace identity with instructions and a live Agent Preset; ordinary tasks have host tools; skills and fine-grained tool permissions remain planned |
| Agent communication connection | A planned permission for agents to communicate; different from a saved provider account |
| Session | A conversation or isolated task context belonging to an agent |
| Attachment | A file sent with a task message; sending waits for every file to be saved, and visual inspection requires model support |
| Run | An execution attempt with persisted state, tool activity, outputs, and errors |
| Skill | Reusable instructions and supporting resources; not an independent permission grant |
| Trigger | A planned source of work such as a schedule or external event; manual task submission already exists |

## Feature status

- **Implemented:** Available as described, subject to the stated limitations.
- **Partial:** Some parts work; the guide identifies what remains unavailable.
- **Planned:** Not available yet. Plans are not a release schedule or a promise of current support.

Feature status does not establish whether the user's local installation is running, a connection is signed in, or a particular account can access a model.
