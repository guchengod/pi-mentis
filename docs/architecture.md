# Architecture

Pi Mentis is an ESM TypeScript monorepo with one-way dependencies: `core` → inference
contracts/storage/parsers → knowledge and memory → retrieval/capabilities → three Pi
extensions. Domain packages do not import Pi or SiliconFlow.

The integrated extension uses a process-isolated architecture. Pi loads a thin adapter that owns
only tool schemas, IPC, and an immutable in-memory Memory Capsule. A forked Mentis Sidecar is the
sole owner of Zvec, remote embedding/Rerank, knowledge ingestion, context inference, capture,
relationship learning, experience extraction, effectiveness traces, and maintenance. The two
processes use a versioned request/response + notification protocol. Sidecar failure never blocks
Pi. The extension starts exactly one child per loaded extension instance, asynchronously during
`session_start`, and uses a single-flight lifecycle state machine so simultaneous tool calls cannot
fork duplicate children or initialize the runtime twice. It keeps the Sidecar alive for the Pi
session and closes it in dependency order during `session_shutdown`. An unexpected exit schedules
a bounded exponential-backoff restart; the replacement reinitializes storage, reopens the latest
session and Branch, then flushes buffered notifications. Explicit RPCs join the same restart
promise instead of spawning another process.

Separate Pi OS processes intentionally have separate Sidecars and coordinate through the existing
storage writer lock. Within one Pi extension process, lifecycle states are
`stopped → starting → ready → restarting → stopping → closed` and only one child may be active.

Working Memory is enabled independently of automatic recall. The Sidecar reduces completed Pi
Events into state keyed by security namespace + Session + Branch and publishes an immutable,
token-bounded projection to the adapter. `before_agent_start` reads only that in-memory projection,
so the foreground hook remains synchronous and performs no filesystem, Zvec, network, model, or
IPC operation. Session compaction and shutdown checkpoint state; restart restores it. A Branch fork
copies the parent checkpoint once, then persists under a different key. Steering invalidates only
active model hypotheses and abandoned plans, not confirmed evidence.

After a completed turn, cheap deterministic triggers may schedule automatic memory formation.
Secret-bearing or transient input is rejected before cognition. The Sidecar sends a bounded,
cancellable request to the current Pi model through versioned IPC and treats the strict JSON result
as an untrusted proposal. Candidate persistence is separate from Memory records: namespace,
Evidence, verified-tool, Scope, durability, repetition, and Secret gates run before optional
promotion, and unpromoted candidates are never retrievable. Explicit `commit_memory` remains the
stronger authority.

TaskEpisode state aggregates multiple Episodes for the same task and Branch. Its digest contains
symbolic actions, failures, verification and Artifact IDs rather than raw outputs. Consolidation
can propose semantic candidates and generalized procedures. Semantic output reuses Candidate gates;
procedures reuse Experience outcome deduplication and Beta qualification. Failed verification is
negative procedure evidence, successful procedure evidence must be verified, and paths abandoned
before the latest Steering event do not contribute to successful generalization.

Automatic recall is disabled by default. When enabled, the Sidecar builds the next immutable capsule after `agent_settled`, writes it through atomic
rename, and publishes it to the adapter over IPC. `before_agent_start` performs bounded lexical
selection over that already-loaded capsule. It is synchronous and performs no filesystem access,
Zvec operation, remote request, hashing of the system prompt, or awaited IPC. Full semantic
retrieval remains available through `search_memory` and executes entirely in the Sidecar. When
automatic recall is disabled, capsule reads, semantic refreshes, and prompt evidence injection are
skipped. When `search_memory` is selected, a compact system-prompt rule tells Pi to search whenever
required information is unknown, uncertain, missing from the current turn, or may be stored in
Mentis; no rule is injected when that tool is unavailable.

The Pi adapter path is `before_agent_start`/`input`/`tool_execution_start`/`tool_result`/
`session_compact`/`agent_settled` → versioned Sidecar messages → Mentis domain events. Conversation
branch and parent provenance comes from Pi's native session leaf and `parentId`; the extension does
not maintain a parallel tree.
Tool-result classification uses only
bytes and tool metadata in the foreground. Results above the configured threshold are stored as
Artifacts and replaced in model context by a Pi-aware symbolic result. Inline capture envelopes are
batched and flushed in order at agent settle. Large text bodies use a private file handoff, so only
metadata is structured-cloned by IPC; the Sidecar validates the opaque ID and consumes the file
once. No LLM is called on this fast path. Artifact publication is an atomic
pending/persisting/ready protocol over a manifest and
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
Episode/Event/Artifact data is ground truth. P9 stores classless atomic assertions: content,
ownership scope, time, provenance, evidence, embedding, lifecycle status, relationship edges, and
decision traces. It does not assign predicate, memory type, semantic domain, or cardinality. P10
gates every candidate before Rerank/model exposure. P11 views are derived, CAS-updated projections
whose fields retain atomic record IDs. P12 writes bounded in-memory traces through deferred batches.
P13 reads an O(1) active policy pointer while replay, Shadow, Canary, EWMA evaluation, and rollback
stay off the answer path. None of these layers duplicates the Artifact/Task/Experience pipeline.

Durable knowledge and migration jobs use queued/leased/running/succeeded/failed/dead states,
bounded retries, lease takeover, and deterministic effects. The scheduler reserves queue and worker
capacity for user-requested work, merges duplicate background jobs, expires stale maintenance work,
and persists critical commands before enqueue acknowledgement. Embedding migration resumes the same
deterministic generation after a crash, validates count and sample retrieval before the atomic
manifest switch, retains the previous generation for rollback, and garbage-collects it only after
`storage.generationRetentionMs`.

`search_memory` and `commit_memory` are parallel-capable Pi tools. Sidecar RPC dispatch is
concurrent, and provider/store limits supply backpressure. Dependent correction flows still search
first and commit afterward. Knowledge additions return after durable enqueue; multiple jobs run in
the isolated scheduler behind a global job semaphore and share one file-parser semaphore without
occupying the Pi foreground process. Sidecar CPU priority and maintenance delay are configurable so
background indexing cannot aggressively compete with the TUI immediately after a turn.

Shutdown is dependency ordered inside the Sidecar, background work gets a grace period and abort
signal, and Pi bounds Sidecar shutdown before terminating it. View and durable knowledge jobs recover
after restart; effectiveness traces are best-effort and use a bounded buffer.
Memory relationship transitions are serialized per security namespace, retain both source records,
and persist structured decision traces alongside their relationship edges.

Relationship learning follows **Write Fast, Consolidate Slow**. `search_memory` records only the
current turn's scope-checked Memory hits. `commit_memory` persists the raw assertion without waiting
for another model call, then a bounded background job compares the new record with at most three
concrete candidates using the current Pi model. Current-turn recalled records have priority; when
there are none, the strongest vector candidate discovered by Core may enter pairwise review. That
similarity signal only selects a candidate and never supplies a relationship. The Pairwise
Reasoner's output is an untrusted semantic proposal, just like both Memory inputs are untrusted
data. A single deterministic dispatch applies relationship-specific gates: reinforcement requires
same referent, same attribute, compatible values, no contradiction, and its threshold, but does not
require `explicitNewAssertion`; supersession and retraction additionally require explicit current
replacement or withdrawal evidence. Supersession requires `replacementValuePresent`; retraction
requires that signal to be false. Conflict has the strictest threshold and rejects both newer
assertion and withdrawal signals. Destructive transitions therefore require convergent independent
signals, and missing or contradictory evidence safely coexists. Similarity alone never changes
lifecycle state. Optional `subjectHint` / `relationHint` / `valueHint` fields are
stored only when produced with accepted pairwise evidence; missing structure never blocks a write.
Paraphrase reinforcement folds the duplicate out of current recall while retaining it as a linked
historical source. Every consolidation remains source-linked and traceable.

While consolidation is pending, a bounded session-local Recent Assertion Overlay provides
read-your-writes semantics. It marks the latest explicit assertion as `provisional_latest`, keeps
the older persistent record visible as `shadowed_by_pending`, and prefers the provisional assertion
only in the recall projection. It never writes a lifecycle status. Acceptance makes the transition
persistent; rejection, failure, expiry, or completion removes the overlay and exposes storage truth.

The minimum supported host is `@earendil-works/pi-coding-agent@0.84.0`. The compatibility guard runs
before tools, Zvec, workers, or models.
