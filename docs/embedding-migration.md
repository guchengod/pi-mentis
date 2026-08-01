# Embedding migration

Migration creates a `preparing` generation, marks it `backfilling`, re-embeds active
records in batches, validates record counts and sample retrieval, then atomically
activates it. The old generation becomes `superseded` and remains available for rollback.
Failures mark only the new generation failed; the old active index remains readable.

Use `/kb migrate-embedding <dimensions>`, poll the returned durable job with
`/kb jobs <job-id>`, and inspect `/kb migration-status`. The fixed-dimension
`BAAI/bge-m3` model cannot migrate across dimensions; use the verified
`Qwen/Qwen3-Embedding-8B` model when dimension selection is required.

After the job completes, set the configured Embedding dimension to the newly active
generation and restart Pi before searching. Roll back with
`/kb rollback-embedding <generation-id>`, restore the old configured dimension, and
restart again. Stop all other writers before migration or rollback.
