# Architecture

Pi Mentis is an ESM TypeScript monorepo with one-way dependencies: `core` → inference
contracts/storage/parsers → knowledge and memory → retrieval/capabilities → three Pi
extensions. Domain packages do not import Pi or SiliconFlow. The shared runtime uses
`Symbol.for("@pi-mentis/pi-mentis/runtime/v1")` and arbitrates providers at priorities
100 (standalone), 200 (integrated), and 300 (explicit override). Providers initialize
lazily on Pi `session_start`; shadowed providers perform no I/O.

The Pi adapter path is `before_agent_start`/`input`/`tool_execution_start`/`tool_result`/
`session_compact`/`agent_settled` → Mentis domain events. Conversation branch and parent provenance
comes from Pi's native session leaf and `parentId`; the extension does not maintain a parallel tree.
Tool-result classification uses only
bytes and tool metadata in the foreground. Results above the configured threshold are stored as
Artifacts and replaced in model context by a Pi-aware symbolic result. No LLM is called on this
fast path.

P8 resolves an immutable faceted context snapshot before capture and recall. Workspace and code
facets are optional; Situation topics, tasks, goals, and interaction mode carry non-code sessions.
Episode/Event/Artifact data is ground truth. User, project, environment, procedure, capability,
task, topic, and episodic memories are atomic derived claims and must retain evidence references.
P9–P13 will add temporal truth, retrieval gates, materialized views, effectiveness evaluation, and
bounded adaptive policy without duplicating the Artifact/Task/Experience pipeline.

The exact supported host is `@earendil-works/pi-coding-agent@0.83.0`, source tag
`v0.83.0`, commit `845d6ff`. The guard runs before tools, Zvec, workers, or models.
