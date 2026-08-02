# P8–P13 architecture and roadmap

Pi Mentis is a personal general-purpose long-term memory system with coding-agent work as its first
priority. Evaluation therefore measures Pi-native adaptation benefit, task benefit in both code and
general scenarios, foreground cost, and implementation complexity. A repository is useful context,
not a prerequisite or a security identity.

## Capability boundary

The completed Tencent stage owns Tool Result Offloading, Artifact Store, Symbolic Tool Result, Task
Graph, Artifact Retrieval, Experience Distillation, Provenance Graph, and Token Accounting. P8–P13
consume those outputs and do not reimplement them.

| Phase | Responsibility                     | Foreground rule                                          |
| ----- | ---------------------------------- | -------------------------------------------------------- |
| P8    | Context & Identity Fabric          | Resolve the immutable minimum snapshot synchronously     |
| P9    | Temporal Truth Engine              | Fetch heads and apply deterministic rules synchronously  |
| P10   | Applicability, Trust & Safety Gate | Filter and score candidates locally                      |
| P11   | Hierarchical State Views           | Read views synchronously; build and patch asynchronously |
| P12   | Memory Effectiveness Evaluation    | Append lightweight traces; aggregate asynchronously      |
| P13   | Safe Adaptive Policy               | O(1) policy lookup; evaluation and optimization offline  |

Only the Pi adapter imports Pi runtime event types. It converts Pi v0.83.0 events to Mentis domain
events and derives branch provenance from the current Pi leaf and its native `parentId`. Pi Mentis
does not own another session tree or context-compression protocol.

## Unified memory domains

Every atomic memory has one domain: `user`, `project`, `environment`, `procedure`, `capability`,
`task`, `topic`, or `episodic`. Code work normally emphasizes project, environment, procedure,
capability, and task. General work normally emphasizes user, topic, task, and episodic memory. The
temporal, gate, view, and evaluation algorithms are shared.

Evidence is immutable ground truth, atomic memory is a reusable claim, and a state view is derived.
No view or summary may become the only source of truth.

## P8 implementation

Implemented in the production extension path:

- Faceted immutable `MentisContextSnapshot`: identity, conversation, optional workspace, situation,
  optional environment, and capability.
- Persistent fingerprint snapshots, latest pointers, cache reuse, and monotonically increasing
  revisions across restart.
- Pi-native leaf/parent provenance; Branch and Compaction remain Pi-owned.
- Optional repository/project identity using explicit ID, normalized origin remote, Git-history
  signature, manifest signature, then canonical path. Git worktrees and packed refs are supported; a
  non-code directory produces no repository or project identity.
- Remote normalization across SSH, SCP-like, and HTTPS Git URLs without hashing repository contents.
- Interaction-mode inference for coding, research, planning, conversation, and operation.
- Pi 0.83 session-scoped models are included in the capability fingerprint, so model-scope changes
  create a new context revision.
- Persisted Topic candidates and active topics with lexical continuation, calibrated score
  distributions, explicit-topic evidence, ambiguous pending state, and no automatic activation from
  a single weak turn.
- Persisted Task identity with continuation reuse and active/completed/failed/aborted lifecycle.
- Context affinity with strict tenant/user/app/agent isolation, project/repository mismatch rejection,
  and denominator-free optional facets so general memories are not penalized for missing code fields.
- Denormalized context on memories and episodes: snapshot, repository, project, workspace, task,
  topic, environment fingerprint, capability snapshot, session, branch, and run.
- Dynamic recall scopes: repository/project/task/topic when present, then user fallback.
- Environment and toolchain facets include OS, architecture, shell, Node version, package manager,
  language, branch, commit, manifests, active tools, tool snippets, Skills, scoped models, and a hash
  of Pi's assembled prompt resources.
- Capability scans are stale-while-revalidate: an old valid snapshot remains active if a refresh
  fails, and removed capabilities are marked inactive.

## P9–P13 implementation

P9 uses append-only atomic claims, deterministic `factKey`, `single`/`set`/`ordered`/`event`
cardinality, current/historical/all modes, revisioned heads, deterministic
reinforce/supersede/coexist/historical/conflict/retract decisions, branch-local hypotheses,
idempotency state, relationship records, and durable Saga repair. A claim is written before its head;
an out-of-order historical single claim never enters the current head.

P10 applies security, domain/context affinity, temporal, branch, project, environment, trust,
evidence-integrity, premise, and instruction-safety gates before Rerank or model exposure. Storage
filters are backed by an application-layer identity check. Exact reads, mutations, knowledge removal,
and document inspection use the same boundary. External/model/knowledge content remains data and
cannot become an instruction merely because it is relevant.

P11 maintains Zvec-backed project, user, topic, task, and capability views through durable View-delta
jobs and CAS retry. Every field retains current and historical atomic memory IDs. Stale reads return
immediately and trigger local background revalidation; failures preserve the old View with failed or
stale state.

P12 appends retrieval traces to a bounded in-memory buffer and flushes batches outside the answer
path. It distinguishes exposure from actual tool-argument use, execution from verification, and
explicit confirmation from correction. Per-memory Beta utility uses priors and gives exposure-only
results fractional credit. Replay features contain hashes rather than raw query text.

P13 protects security scope, instruction safety, evidence integrity, deletion rules, and the minimum
trust floor. It uses deterministic local replay, changes one bounded coordinate per candidate,
retires losing drafts, runs Shadow without remote Rerank, buckets Canary requests deterministically,
persists EWMA/cooldown state, and rolls back degraded active policies to a durable fallback.

## Implementation order and release gates

Implementation is complete in the production extension path. Release remains gated on the separate
functional, fault-injection, restart, security, live-provider, and performance suites. Those suites
must establish the target incremental P95 foreground cost below 20 ms; implementation status alone
does not claim the measured budget.

Target incremental P95 foreground cost for P8–P13 combined is below 20 ms. Deep capability scans,
semantic conflict analysis, LLM temporal classification, view rebuilding, effectiveness aggregation,
offline replay, strategy optimization, Shadow analysis, garbage collection, and repair never run on
Pi's answer path.
