# Extensions

`@galvinsan/pi-mentis-knowledge` registers `commit_knowledge` and `search_knowledge`
only when no memory provider wins. `@galvinsan/pi-mentis-memory` registers
`commit_memory` and `search_memory`. The integrated `@galvinsan/pi-mentis` also exposes
only memory tools, but `search_memory` performs knowledge-first retrieval. All three
preserve the same public tool contracts.

The integrated product runs its providers in a forked Mentis Sidecar. Its Pi process contains only
tool registration, versioned IPC, and an immutable Memory Capsule. The standalone memory and
knowledge products retain their direct provider runtime for installations that intentionally choose
one subsystem. Install exactly one extension product so only one process owns a storage root.

The integrated adapter starts one supervised Sidecar asynchronously at `session_start`, shares a
single-flight start/restart across concurrent calls, and stops it at `session_shutdown`. Unexpected
exit automatically restores the latest session and Branch before buffered notifications resume.
`search_memory` and independent `commit_memory` calls are parallel-capable. Knowledge additions are
durable queued jobs whose parsing and embedding stay inside the Sidecar.

Automatic recall defaults to off. Both memory-capable products add explicit Pi system guidance to
use `search_memory` for unknown, uncertain, missing, historical, or indexed information. Enabling
`retrieval.automaticRecall` adds capsule evidence to turns and may increase perceived TUI latency.

Install one product with `pi install <package>`. The in-process shared runtime remains available to
the standalone products and library consumers; integrated-product services are intentionally behind
the Sidecar protocol and are not exposed as mutable in-process objects.
