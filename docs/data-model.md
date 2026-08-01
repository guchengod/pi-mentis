# Data model

Scalar Zvec collections are `knowledge_sources_v1`, `knowledge_documents_v1`,
`jobs_v1`, `relationships_v1`, `episodes_v1`, `events_v1`, and `artifacts_v1`.
Artifact bodies are private files below the storage root; `artifacts_v1` stores their immutable
identity, hash, size, media type, and provenance. Vector collections are immutable generations:
`knowledge_chunks_g_<id>`, `memory_records_g_<id>`, and `capabilities_g_<id>`.
`active-index-manifest.json` atomically selects one active generation per kind.

IDs are domain-separated SHA-256 hashes of canonical source, logical document,
semantic chunk key, normalized content, and scope. Payloads are JSON objects; vectors,
filter fields, FTS text, authority, revision, and timestamps are first-class Zvec fields.
Memory status includes pending, active, superseded, conflicted, tombstoned, and rejected.
Every memory has one domain: user, project, environment, procedure, capability, task, topic, or
episodic. Memory namespaces include tenant, user, app, and agent as strict identity fields. Optional
denormalized affinity fields include context snapshot, repository, project, workspace, task, topics,
environment fingerprint, capability snapshot, session, branch, and run. Missing code fields are
neutral for general memories; repository mismatch is material for project facts.

P8 context snapshots currently use the in-process resolver. Persistent StateStore snapshots remain
pending. P9 will store temporal claims in the memory collection and deterministic temporal heads in
StateStore. P11 is the only planned new primary collection (`mentis_views`); traces reuse events,
jobs reuse the job store, and relationships reuse the relationship store.
