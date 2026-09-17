SELECT coalesce(
    (SELECT attnotnull AND atttypid = 'tsvector'::regtype FROM pg_attribute
     WHERE attrelid = 'public.fragments'::regclass AND attname = 'search_vector' AND NOT attisdropped)
    AND (SELECT atttypid = 'integer'::regtype FROM pg_attribute
     WHERE attrelid = 'public.fragments'::regclass AND attname = 'fragment_index' AND NOT attisdropped)
    AND NOT EXISTS (
        SELECT 1 FROM (VALUES
            ('fragments_document_search_idx', 'gin', ARRAY['search_vector']),
            ('fragments_document_order_idx', 'btree', ARRAY['memory_id', 'fragment_index', 'id'])
        ) AS expected(name, method, columns)
        LEFT JOIN pg_class ON pg_class.oid = to_regclass('public.' || expected.name)
        LEFT JOIN pg_index ON indexrelid = pg_class.oid
        LEFT JOIN pg_am ON pg_am.oid = pg_class.relam
        WHERE NOT coalesce(indisvalid AND indisready AND indrelid = 'public.fragments'::regclass
            AND amname = expected.method AND indpred IS NULL AND indexprs IS NULL
            AND ARRAY(SELECT attname::text FROM unnest(indkey) WITH ORDINALITY AS keys(attnum, position)
                JOIN pg_attribute ON attrelid = indrelid AND pg_attribute.attnum = keys.attnum
                ORDER BY position) = expected.columns, false)
    )
    AND (SELECT count(*) = 2 FROM pg_trigger
        WHERE NOT tgisinternal AND tgenabled IN ('O', 'A') AND (
            (tgrelid = 'public.fragments'::regclass AND tgname = 'fragments_search_vector'
             AND tgfoid = 'public.mindleak_fragment_search_vector()'::regprocedure)
            OR (tgrelid = 'public.memories'::regclass AND tgname = 'memories_search_vectors'
             AND tgfoid = 'public.mindleak_memory_search_vectors()'::regprocedure)))
    AND (SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'public.fragments'::regclass AND conname = 'fragments_fragment_index_check')
    AND public.mindleak_document_vector('System.Reflection.TargetInvocationException wraps failure',
        '{"source":"https://example.com/wiki/AuthFlow/config-file.md","summary":"rollout review"}'::jsonb)
        @@ websearch_to_tsquery('pg_catalog.english', 'TargetInvocationException AuthFlow rollout'),
    false);
