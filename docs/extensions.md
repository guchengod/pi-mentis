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

Install one product with `pi install <package>`. The in-process shared runtime remains available to
the standalone products and library consumers; integrated-product services are intentionally behind
the Sidecar protocol and are not exposed as mutable in-process objects.
