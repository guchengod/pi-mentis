# State Machine Report

Date: 2026-08-01

Overall release gate: **FAIL**

## Verified state behavior

| State area            | Evidence                                                                               | Result  |
| --------------------- | -------------------------------------------------------------------------------------- | ------- |
| Provider arbitration  | Winner-only initialization, conflict rejection, failure fallback, disposal order       | PASS    |
| Durable job execution | Queued jobs reach succeeded/failed/dead states; live knowledge jobs are polled durably | PARTIAL |
| Memory evolution      | Create, reinforce, supersede, conflict, history preservation, idempotency              | PASS    |
| Temporal claims       | Single-head invariant, out-of-order events, conflicts, branch isolation, repair        | PASS    |
| Task graph            | Dependencies, legal transitions, cycle rejection, branch abort                         | PASS    |
| Adaptive policy       | Protected invariants, shadow, canary, rollback, cooldown, restart                      | PASS    |
| Views                 | Evidence-backed aggregation, revision CAS, stale state, cross-scope isolation          | PARTIAL |
| Artifact              | Persist, ready-only offload, exact replay, restart                                     | PARTIAL |

Property tests exercise arbitrary temporal event orders and identity boundaries. Real-Zvec
integration tests reopen collections and verify persisted temporal, view, policy, task, artifact,
and state-store data.

## Missing release proof

- The declared requirement is 100% coverage of every legal and illegal transition. No generated
  transition matrix currently demonstrates that number.
- Provider `shadowed`, every job lease takeover path, all artifact failure/expiry/delete paths,
  all view rebuild failures, and every policy illegal transition are not exhaustively covered.
- The Temporal Saga crash points A-G are not each killed and repaired in a separate-process test.
- Disk-full, lease-expiry, corrupt head, missing artifact chunk, and shutdown-timeout states remain
  unverified.

Because exhaustive transition coverage is absent, a passing subset cannot satisfy the 100%
release threshold.

## Evidence

- `integration-tests/intelligence-state.integration.test.ts`
- `integration-tests/zvec-knowledge.integration.test.ts`
- `packages/core/test/invariants.property.test.ts`
- `packages/memory/test/safety-views.property.test.ts`
- `packages/retrieval/test/gates-policy.property.test.ts`
