WITH batch AS MATERIALIZED (
    SELECT id, memory_id, text, ctid AS tuple_id
    FROM public.fragments
    WHERE ($1::uuid IS NULL OR (memory_id, id) > ($1, $2::uuid))
      AND search_vector IS NULL
    ORDER BY memory_id, id
    LIMIT $3
), sources AS MATERIALIZED (
    SELECT selected.memory_id AS id, metadata.vector
    FROM (SELECT DISTINCT memory_id FROM batch) AS selected
    CROSS JOIN LATERAL (
        SELECT public.mindleak_document_metadata_vector(context) AS vector
        FROM public.memories WHERE id = selected.memory_id LIMIT 1
    ) AS metadata
), updated AS (
    UPDATE public.fragments AS fragments
    SET search_vector = setweight(public.mindleak_keyword_vector(batch.text), 'C') || sources.vector
    FROM batch JOIN sources ON sources.id = batch.memory_id
        WHERE fragments.ctid = batch.tuple_id
            AND fragments.ctid = ANY (ARRAY(SELECT tuple_id FROM batch))
    RETURNING fragments.id
)
SELECT (SELECT count(*) FROM updated),
    (SELECT memory_id FROM batch ORDER BY memory_id DESC, id DESC LIMIT 1),
    (SELECT id FROM batch ORDER BY memory_id DESC, id DESC LIMIT 1);
