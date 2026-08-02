# Progress

The production path now implements P8–P13 on top of the existing Artifact, Episode/Event,
Experience, provenance, and token-accounting pipeline.

- The Tencent/P7 foundation now includes durable leased ingest and migration jobs, chunked atomic
  Artifact publication/recovery/range retrieval/GC, Episode-bound Task Graph transitions,
  evidence-chain search, branch-safe Experience promotion, provenance edges, and explicit token
  savings. These are production paths rather than interface placeholders.

- P8 persists revisioned context, Topic, Task, repository, environment, and capability identity.
  Repository identity survives path changes when Git identity is stable; non-code sessions retain
  user/topic/task context. Pi leaf and parent IDs remain the only conversation tree.
- P9 stores append-only atomic claims, deterministic temporal heads and relationships, supports all
  cardinalities and historical modes, isolates branch hypotheses, and repairs interrupted Sagas.
- P10 enforces tenant/user/app/agent isolation in storage and again in application code, then applies
  project, temporal, environment, trust, premise, and instruction-safety gates.
- P11 maintains CAS-updated project, user, topic, task, and capability views. Deltas are durable jobs,
  stale views revalidate in the background, and every field retains atomic-memory provenance.
- P12 records bounded non-blocking retrieval traces, separates exposure from use, attributes
  execution/verification/user outcomes, and maintains Bayesian utility and diagnostics.
- P13 performs deterministic offline replay, one-coordinate candidate generation, Shadow and
  deterministic Canary evaluation, EWMA drift detection, cooldown, and durable rollback. Protected
  safety invariants cannot be adapted or disabled.

Both integrated and memory-only extensions expose the same memory semantics. `/kb status` on the
integrated package and `/mentis status` on the memory-only package report the live context, views,
trace buffer, effectiveness summary, and policy lifecycle.

Functional and live validation is intentionally tracked separately from implementation status; see
the test plan and reports for measured latency and production E2E evidence.
