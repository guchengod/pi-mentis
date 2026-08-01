# Embedding migration

Migration creates a `preparing` generation, marks it `backfilling`, re-embeds active
records in batches, validates record counts and sample retrieval, then atomically
activates it. The old generation becomes `superseded` and remains available for rollback.
Failures mark only the new generation failed; the old active index remains readable.

Use `/kb migrate-embedding <dimensions>` and inspect `/kb migration-status`. Roll back
with `/kb rollback-embedding <generation-id>`. Stop all other writers before migration.
