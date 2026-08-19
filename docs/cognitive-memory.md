# Cognitive Memory

Pi Mentis separates immediate task continuity, potential durable knowledge, and qualified long-term
memory. This avoids treating every model inference or successful tool call as a fact.

## Working Memory

Working Memory is a deterministic projection of Pi Episodes and Events. It stores the active goal,
subgoals, confirmed facts, hypotheses, decisions, open loops, active resources, recent outcomes,
recalled Memory IDs, and Artifact IDs. It never copies a large tool result into state. The identity
key is the full Mentis security namespace plus the native Pi Session and Branch.

The Sidecar owns reduction and persistence. The Pi adapter owns only the latest immutable snapshot.
`before_agent_start` synchronously renders that snapshot within its token budget. Compaction,
restart, Branch fork, verification, and Steering therefore have explicit state transitions instead
of relying on an LLM to reconstruct the task from transcript text.

## Memory Candidates

Automatic formation has four stages:

1. Local triggers select explicit durable statements, corrections, commitments, and stable
   preferences while skipping ordinary questions and speculative/transient text.
2. Secret detection runs before any model request.
3. The current Pi model receives a bounded, cancellable cognition request and must return strict
   structured proposals with Evidence IDs.
4. Deterministic gates enforce namespace, source, grounding, verified-tool claims, Scope,
   confidence, durability, repetition, and Secret policy.

Candidates live in a state collection, not the Memory record hierarchy. In the default shadow mode
(`autoPromotion: false`) they can be inspected and reinforced but cannot be retrieved. Eligible
automatic candidates are committed only through `MemoryService.commit`; explicit user memory writes
retain higher authority.

## TaskEpisode Consolidation

A TaskEpisode groups Pi Episodes by task and Branch. Its bounded digest references Artifacts and
Evidence without embedding raw large outputs. Terminal verification, failed verification, or a
long-task checkpoint may schedule cognition.

Semantic assertions are routed into Memory Candidates. Generalized procedures are routed into the
Experience service. Each unique Evidence outcome updates success/failure counts; duplicate Evidence
does not. A procedure becomes durable only after the configured minimum outcome count and Beta
success estimate. Failed verification is recorded as a negative observation. Aborted or unknown
verification is ignored.

## Security and failure behavior

- Tenant, user, app, and agent are part of every state namespace; Session and Branch further isolate
  Working Memory.
- Background jobs freeze the Scope that existed when they were scheduled, so a later Branch switch
  cannot redirect their result.
- Cognition output is untrusted and cannot supply missing Evidence or widen user-global Scope.
- New user input cancels outstanding relationship and cognition requests.
- Sidecar/model failures are fail-open for Pi interaction and fail-closed for memory promotion.
- Working Memory remains available when automatic recall is disabled.

Telemetry exposed by Sidecar status includes visible Working Memory tokens, Candidate triggers,
cognition runs/failures/cancellations, Candidate creation/rejection/promotion, consolidation runs,
semantic assertions, and procedure observation/qualification/promotion counters.
