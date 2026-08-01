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

## P8 current implementation

Implemented in the production extension path:

- Faceted immutable `MentisContextSnapshot`: identity, conversation, optional workspace, situation,
  optional environment, and capability.
- Synchronous fingerprint cache with snapshot reuse and monotonically increasing revisions.
- Pi-native leaf/parent provenance; Branch and Compaction remain Pi-owned.
- Optional repository/project identity. The implemented fast resolver uses explicit ID, normalized
  origin remote, manifest identity, then canonical repository path. A non-code directory produces no
  repository or project identity.
- Remote normalization across SSH, SCP-like, and HTTPS Git URLs without hashing repository contents.
- Interaction-mode inference for coding, research, planning, conversation, and operation.
- Pi 0.83 session-scoped models are included in the capability fingerprint, so model-scope changes
  create a new context revision.
- Topic resolution contracts with explicit/active-topic reuse, calibrated vector thresholds,
  ambiguous pending state, and no per-turn topic creation.
- Context affinity with strict tenant/user/app/agent isolation, project/repository mismatch rejection,
  and denominator-free optional facets so general memories are not penalized for missing code fields.
- Denormalized context on memories and episodes: snapshot, repository, project, workspace, task,
  topic, environment fingerprint, capability snapshot, session, branch, and run.
- Dynamic recall scopes: repository/project/task/topic when present, then user fallback.

P8 is not yet complete. Remaining work is persistent snapshot storage in StateStore, a stable
repository-signature strategy between manifest and path fallbacks, background Git and capability
refresh with stale-while-revalidate, persisted Topic candidates plus calibrated embedding
distributions, task identity, full environment/toolchain probing, and measured P95 budgets. These
are not claimed by the in-memory resolver.

## P9–P13 implementation contract

P9 adds append-only temporal claims, deterministic `factKey`, cardinality (`single`, `set`,
`ordered`, `event`), temporal modes, materialized heads, reinforce/supersede/coexist/conflict/retract
decisions, branch-local hypotheses, and Saga repair. It must write the new claim before advancing a
head.

P10 applies a chain of gates: security scope, domain compatibility, P8 affinity, temporal validity,
environment applicability, trust, premises, instruction safety, and diversity/budget. Retrieval
relevance alone never grants instruction authority.

P11 creates Zvec-backed materialized project, user, topic, task, and capability views. Every field
must retain atomic-memory IDs. View deltas reuse the existing job store and all updates run in the
background.

P12 records sampled retrieval traces, observable usage signals, task outcomes, and Bayesian-smoothed
utility. It references Tencent token accounting rather than duplicating cost collection.

P13 optimizes only bounded retrieval parameters through offline replay, constrained coordinate
descent, Shadow, Canary, EWMA drift detection, and rollback. Security isolation, instruction safety,
evidence integrity, and deletion rules are invariants and are never adaptive.

## Implementation order and release gates

1. Finish P8 persistence, topic/task identity, background refresh, and latency measurements.
2. Implement P9 temporal claims, heads, transitions, and repair.
3. Implement P10 gates and query-time scalar prefilters.
4. Release P8–P10 together only after code and non-code recall cases pass.
5. Add P11 views, then P12 evaluation, then P13 adaptive policy.

Target incremental P95 foreground cost for P8–P13 combined is below 20 ms. Deep capability scans,
semantic conflict analysis, LLM temporal classification, view rebuilding, effectiveness aggregation,
offline replay, strategy optimization, Shadow analysis, garbage collection, and repair never run on
Pi's answer path.
