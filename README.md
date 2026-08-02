# Pi Mentis

Pi Mentis is a personal general-purpose long-term memory system for Pi `v0.83.0`, with coding-agent
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

Install exactly one extension product into Pi v0.83.0:

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

The integrated and memory products include persistent faceted context, temporal truth, strict
retrieval gates, provenance-backed state views, non-blocking effectiveness attribution, and bounded
Shadow/Canary adaptive retrieval. Inspect them with `/kb status` (integrated) or `/mentis status`
(memory-only).

## Development and verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm benchmark:smoke
pnpm benchmark
pnpm pack:extensions
```

Live SiliconFlow tests are opt-in:

```bash
source ~/.zshrc
pnpm test:live
```

The live test requires all three variables and never substitutes a default model.
The API key is never printed or stored in Zvec, manifests, diagnostics, or logs.

Configuration, operations, migrations, package boundaries, parsers, retrieval,
and performance methodology are documented in [`docs/`](docs/architecture.md).

The npm README for the integrated product contains a complete Chinese quick start,
configuration reference, memory examples, ordered documentation-site ingestion guide,
command table, storage rules, security boundaries, backup procedure, and troubleshooting:
[`@galvinsan/pi-mentis`](packages/pi-context-extension/README.md).
