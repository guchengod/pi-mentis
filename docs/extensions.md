# Extensions

`@galvinsan/pi-mentis-knowledge` registers `commit_knowledge` and `search_knowledge`
only when no memory provider wins. `@galvinsan/pi-mentis-memory` registers
`commit_memory` and `search_memory`. The integrated `@galvinsan/pi-mentis` also exposes
only memory tools, but `search_memory` performs knowledge-first retrieval. All three
declare providers before session start and register dynamic tools after arbitration.

Install one product with `pi install <package>`. Another extension can obtain the shared
library service through `getOrCreateRuntime().getKnowledge<KnowledgeService>()` after
`await runtime.ready(context.signal)`.
