# Security Report

Date: 2026-08-01

Overall release gate: **FAIL**

## Verified

- `pnpm audit --prod --audit-level high`: no known production dependency vulnerabilities.
- Archive traversal, entry-count bomb, compressed-size limit, expanded-size bomb, malformed ZIP,
  XML DTD/entity injection, directory symlink escape, and private-network web sources are rejected.
- Property tests hard reject cross-tenant/user/app/agent, cross-project, malformed, retired, and
  unverified-branch memories.
- External prompt-injection text remains data and cannot become a grounded user instruction.
- Derived views require atomic-memory provenance and matching security scope.
- Published tarball dry runs contain only LICENSE, README, package.json, and built dist entry files.
- Sanitized live reports contain no API key, Authorization header, request header, or input body.

## Missing release proof

- No complete adversarial suite yet covers malicious Skill descriptions, malicious MCP schemas,
  unauthorized `forget_memory`, forged evidence refs, forged temporal heads, wrong-artifact
  deletion, recursive archives at every supported nesting level, parser CPU exhaustion, and disk
  exhaustion.
- Cross-user and cross-tenant exposure are zero in the covered invariant cases, but the release
  specification requires a complete benchmark corpus with zero aggregate exposure.
- No independent dependency/license/SBOM review was performed.

The covered security controls pass, but the enumerated security suite is incomplete, so the
release security gate is not satisfied.

## Evidence

- `packages/file-parsers/test/security.test.ts`
- `packages/file-parsers/test/web-source.test.ts`
- `packages/memory/test/safety-views.property.test.ts`
- `packages/retrieval/test/gates-policy.property.test.ts`
- `.artifacts/live-e2e/live-e2e-20260801T122522668Z-7e242a/reports/live-e2e.json`
