# Recovery Report

Date: 2026-08-01

Overall release gate: **FAIL**

## Verified recovery paths

- Real Pi/Zvec process restart preserved knowledge and memory and recalled the persisted record.
- Real embedding-generation migration completed create, backfill, validate, shadow, switch,
  rollback, and restart checks with four full process restarts.
- Invalid SiliconFlow credentials fail with `ProviderAuthenticationError`; a valid provider works
  immediately afterward.
- Invalid Embedding models fail capability validation before data writes.
- Invalid Rerank models degrade to the local fusion result without failing retrieval; restoring
  the model restores remote ranking and clears the degradation diagnostic.
- Concurrent first-open of a Zvec collection is single-flighted.
- Temporal repair restores a valid single head, relationships, and revision monotonicity in the
  covered integration scenarios.

## Missing release proof

- No separate-process crash matrix injects failures at each Artifact, Temporal, View, and durable
  job Saga step.
- No disk-full, corrupt-document, missing-chunk, lease-timeout takeover, queue-backlog,
  shutdown-timeout, or unclean OS termination scenario is complete.
- Exactly-once effects after “success before ack” are tested at the service level only, not across
  a killed process for every durable job type.
- Crash recovery success therefore cannot be reported as the required 100%.
- No 24-hour soak proves zero durable-job loss, no sustained memory growth, and recoverable
  shutdown backlog.

## Evidence

- `integration-tests/intelligence-state.integration.test.ts`
- `integration-tests/zvec-knowledge.integration.test.ts`
- `.artifacts/live-e2e/live-e2e-20260801T122522668Z-7e242a/reports/live-e2e.json`
- `.artifacts/live-e2e/live-e2e-20260801T051909069Z-bfcbcf/reports/live-e2e.json`
