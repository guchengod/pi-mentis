# Data model

Scalar Zvec collections are `knowledge_sources_v1`, `knowledge_documents_v1`,
`jobs_v1`, `relationships_v1`, `episodes_v1`, `events_v1`, `artifacts_v1`,
`mentis_state_v1`, and `mentis_views_v1`.
Artifact bodies are private files below the storage root; `artifacts_v1` stores their immutable
identity, security namespace, hash, size, media type, lifecycle, ordered chunk manifest, and
provenance. Artifact lifecycle is `pending → persisting → ready`, with explicit `failed`, `expired`,
and `deleted` terminals. Only `ready` content can replace a Pi Tool Result; every chunk and the full
body are SHA-256 verified. Vector collections are immutable generations:
`knowledge_chunks_g_<id>`, `memory_records_g_<id>`, and `capabilities_g_<id>`.
`active-index-manifest.json` atomically selects one active generation per kind.

IDs are domain-separated SHA-256 hashes. Knowledge IDs include canonical source, logical document,
and stable chunk identity; Memory IDs include normalized raw content, ownership scope, observation,
and idempotency identity. Payloads are JSON objects; vectors,
filter fields, FTS text, authority, revision, and timestamps are first-class Zvec fields.
Memory status includes pending, active, superseded, conflicted, tombstoned, and rejected.
Memory records are classless assertions containing raw content, provenance, evidence references,
embedding, lifecycle status, and relationship edges. They do not store Predicate, Memory Type,
semantic Domain, Cardinality, Fact Key, or Semantic Key. Optional `subjectHint`, `relationHint`, and
`valueHint` fields can accompany accepted pairwise evidence but never determine whether a record is
stored. Memory namespaces include tenant, user, app, and agent as strict identity fields. Optional
denormalized affinity fields include context snapshot, repository, project, workspace, task, topics,
environment fingerprint, capability snapshot, session, branch, and run. Missing code fields are
neutral for general memories; repository mismatch is material for project facts.

`mentis_state_v1` stores revisioned context pointers/snapshots, Topic and Task identity, temporal
heads and Sagas, idempotency state, utility, policy records, policy pointers, EWMA, and cooldown.
`mentis_views_v1` stores revisioned project/user/topic/task/capability views. Temporal claims remain
atomic memory vectors; reinforce/supersede/retract/conflict/coexist edges and decision traces reuse
`relationships_v1`; durable View deltas reuse
`jobs_v1`; retrieval traces and outcomes reuse `events_v1`.

Knowledge ingest and Embedding migration jobs persist the command before returning acceptance. Their
state is `queued → leased → running → succeeded`, with retryable `failed` and terminal `dead` paths.
Leases carry worker identity and expiry; after the single-writer lock proves the previous process is
gone, startup recovery takes over incomplete leases. Deterministic source/chunk/generation IDs make
at-least-once execution safe. `relationships_v1` also stores the Task Graph with
`pending/running/succeeded/failed/blocked/aborted` nodes, dependency edges, branch provenance, and
event evidence.

Views can never introduce a fact: every delta exact-fetches its atomic memory first. Trace replay
stores hashed lexical features rather than raw query text. Security identity is denormalized into
knowledge and memory namespaces and checked again after reads and before exact mutation/inspection.
