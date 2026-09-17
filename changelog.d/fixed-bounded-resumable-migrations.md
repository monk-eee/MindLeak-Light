- Large-corpus startup upgrades now commit bounded document-search and fragment-order
	batches with durable checkpoints, reuse per-source calculations, and recover
	interrupted index builds. Migration-only timeouts and secret-safe progress leave
	normal query limits and durability enabled. Add `--migrate-only` and optional
	read-only retrieval canaries that must pass in the candidate runtime before
	readiness. See the migration guide for offline upgrade and resume requirements.
