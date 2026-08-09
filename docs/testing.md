# Testing

Pi Mentis keeps three deliberately separate verification layers.

## Fast unit suite

`pnpm test` covers deterministic contracts and safety boundaries. It must not open Zvec, access the
network, load Pi, or depend on timing. Extend an existing file when possible. Do not add tests for
TypeScript shape existence, trivial getters, default-value wiring, or multiple examples of the same
invariant.

## Persistent E2E suite

`pnpm test:e2e` runs the two real-Zvec workflows under `integration-tests/`. They own persistence,
relationship evolution, scope-correct recall, artifact
round trips, migration, restart, and graceful Rerank degradation. Storage behavior should be added
to these workflows instead of creating native-store unit tests.

## Real model acceptance

`PI_MENTIS_LIVE_E2E=1 pnpm test:e2e:live` runs the ten-case Pi model-backed relationship suite. It is
the only networked acceptance suite and remains opt-in because it consumes provider quota.

A new test must protect a distinct externally visible behavior, persistent invariant, or security
boundary that is not already covered by one of these layers.
