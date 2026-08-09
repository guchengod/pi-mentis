# Pi Mentis

Pi Mentis is a personal general-purpose long-term memory system for Pi `>=0.84.0`, with coding-agent
work as its first-priority scenario. It is Pi-aware but not repository-bound: project, repository,
runtime, and package-manager context are optional, while user, topic, task, and episodic memory work
without a code workspace.

The Pi adapter derives conversation provenance from Pi's native Session tree, Branch, Steering, and
Compaction semantics; it does not maintain a second session tree or a second compaction system.
Domain packages remain independent of Pi event types. See [the P8–P13 roadmap](docs/pi-native-roadmap.md)
for the corrected capability boundary and implementation status.

The repository is an ESM TypeScript monorepo requiring Node.js `>=22.19.0` and
pnpm. See [docs/architecture.md](docs/architecture.md) for package boundaries and
[docs/configuration.md](docs/configuration.md) for a safe configuration example.

## Install

```bash
pnpm install
pnpm build
```

Install exactly one extension product into Pi 0.84 or newer:

```bash
pi install npm:@galvinsan/pi-mentis
# or npm:@galvinsan/pi-mentis-knowledge
# or npm:@galvinsan/pi-mentis-memory
```

Set the provider credential and start Pi:

```bash
export SILICONFLOW_API_KEY=...
pi
```

The knowledge-only product exposes `commit_knowledge` and `search_knowledge`.
The memory-only product exposes `commit_memory` and `search_memory`. The default
integrated product also exposes only the memory pair; its search is knowledge-first
and its automatic recall inserts evidence as explicitly untrusted data.

The integrated and memory products use classless atomic assertions: raw content is stored first,
while exact identity, provenance, conservative relationships, and a semantic-agnostic temporal
state machine protect correctness. When the agent recalls a concrete prior memory and then commits
a newer assertion in the same turn, a background pairwise reasoner prioritizes that pair. Without
an explicit recall, slow consolidation may review the strongest vector candidate, but similarity
never supplies relationship evidence by itself. The reasoner can learn reinforcement, supersession,
retraction, or conflict edges, but its output is an untrusted proposal: relationship-specific
deterministic gates alone authorize persistent transitions. A session-local pending assertion
overlay provides read-your-writes recall without changing persistent lifecycle status. The reasoner
compares two records directly; it does not
restore a predicate, memory-type, cardinality, or phrase classifier. Uncertain pairs continue to
coexist, and consolidation preserves source records and decision traces. They also include persistent faceted context, strict
retrieval gates, provenance-backed state views, non-blocking effectiveness attribution, and bounded
Shadow/Canary adaptive retrieval. Inspect them with `/kb status` (integrated) or `/mentis status`
(memory-only).

The public memory API intentionally stays small: `commit_memory` accepts only `content`, while
`search_memory` accepts `query`, `id`, or both. New records do not require a predicate, memory type,
domain, cardinality, fact key, or semantic key.

## Development and verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm pack:extensions
```

`pnpm test` is the fast, native-store-free unit suite. `pnpm test:e2e` is the only local persistent
E2E suite and owns real Zvec/restart coverage. Real Pi model-backed relationship acceptance is
opt-in:

```bash
source ~/.zshrc
PI_MENTIS_LIVE_E2E=1 pnpm test:e2e:live
```

The live E2E requires the configured provider variables and never substitutes a default model.
The API key is never printed or stored in Zvec, manifests, diagnostics, or logs.

Configuration, operations, migrations, package boundaries, parsers, retrieval,
and performance methodology are documented in [`docs/`](docs/architecture.md).
The intentionally small test matrix and criteria for adding tests are documented in
[`docs/testing.md`](docs/testing.md).

The npm README for the integrated product contains a complete Chinese quick start,
configuration reference, memory examples, ordered documentation-site ingestion guide,
command table, storage rules, security boundaries, backup procedure, and troubleshooting:
[`@galvinsan/pi-mentis`](packages/pi-context-extension/README.md).
