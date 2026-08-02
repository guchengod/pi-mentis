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
fast path. Artifact publication is an atomic pending/persisting/ready protocol over a manifest and
1 MiB hashed chunks. `search_memory` can search an evidence chain or read a scope-checked UTF-8-safe
byte range without loading the entire Artifact. Every replacement records conservative original,
retained, and offloaded token counts.

Each Episode is also a Task Graph root. Tool calls become child nodes, Tool Results transition them
to succeeded/failed with Event evidence, and Steering aborts unfinished nodes from the invalidated
plan. Dependencies reject missing endpoints and cycles. The graph remains execution structure, not
fact authority. Experience distillation only considers failure → recovery → successful verification
after the latest Steering event; forked-branch experience remains a branch hypothesis rather than a
global procedure.

P8 resolves an immutable faceted context snapshot before capture and recall. Workspace and code
facets are optional; Situation topics, tasks, goals, and interaction mode carry non-code sessions.
Episode/Event/Artifact data is ground truth. User, project, environment, procedure, capability,
task, topic, and episodic memories are atomic derived claims and must retain evidence references.
P9 stores temporal heads and Saga state in revisioned Zvec scalar state. P10 gates every candidate
before Rerank/model exposure. P11 views are derived, CAS-updated projections whose fields retain
atomic memory IDs. P12 writes bounded in-memory traces through deferred batches. P13 reads an O(1)
active policy pointer while replay, Shadow, Canary, EWMA evaluation, and rollback stay off the answer
path. None of these layers duplicates the Artifact/Task/Experience pipeline.

Durable knowledge and migration jobs use queued/leased/running/succeeded/failed/dead states,
bounded retries, lease takeover, and deterministic effects. The scheduler reserves queue and worker
capacity for user-requested work, merges duplicate background jobs, expires stale maintenance work,
and persists critical commands before enqueue acknowledgement. Embedding migration resumes the same
deterministic generation after a crash, validates count and sample retrieval before the atomic
manifest switch, retains the previous generation for rollback, and garbage-collects it only after
`storage.generationRetentionMs`.

Shutdown is dependency ordered (retrieval → memory → knowledge → inference), background work gets a
grace period and abort signal, and provider disposal is bounded to five seconds. View jobs and
temporal Sagas are durable and repaired after restart; effectiveness traces are best-effort and use
a bounded buffer. Artifact, temporal, View, and durable Job repair run during startup maintenance.

The exact supported host is `@earendil-works/pi-coding-agent@0.83.0`, source tag
`v0.83.0`, commit `845d6ff`. The guard runs before tools, Zvec, workers, or models.
