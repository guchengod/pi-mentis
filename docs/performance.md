# Performance

The integrated Pi foreground process contains no Zvec instance, query embedding, Rerank, capture
persistence, or maintenance scheduler. Those operations run in the Mentis Sidecar. Ingest, parsing,
document embedding, writes, capability sync, capture, and migration use bounded scheduling inside
that isolated process.

Pi automatic recall is disabled by default. Normal turns instead rely on the system-prompt rule that
directs Pi to call `search_memory` for unknown or missing durable context. When explicitly enabled,
automatic recall is a synchronous selection over an immutable in-memory Memory Capsule. It has
no storage lock, timer, Promise, remote request, or IPC round trip in `before_agent_start`. Explicit
`search_memory` requests retain the full semantic retrieval path through Sidecar RPC. The Sidecar
refreshes context, relationships, experience, views, and the next capsule after the agent settles.
Even though selection itself is local, automatic evidence increases prompt size and enables
post-turn semantic refresh, so it can add perceptible latency after a TUI message is sent.

Sidecar startup and restart are single-flight. Concurrent tool requests share the same lifecycle
promise and then dispatch concurrently; they never create one process per request. Memory searches,
independent commits, and durable knowledge-ingest jobs can overlap subject to provider, scheduler,
parser, and storage limits. Pi shutdown stops accepting restarts, drains bounded work, closes the
store, and then terminates the child.

Performance measurement is intentionally not part of the automated test matrix. Use production
telemetry and explicit profiling runs when changing a hot path; do not add benchmark-shaped tests to
the default unit or E2E suites. Measure local CPU, Zvec, and remote latency separately.
