WITH batch AS MATERIALIZED (
    SELECT id, regexp_replace(raw_text, '[[:space:]]+', ' ', 'g') AS normalized_text
    FROM public.memories
    WHERE ($1::uuid IS NULL OR id > $1)
    ORDER BY id LIMIT $3
), positions AS MATERIALIZED (
    SELECT fragments.id, fragments.tuple_id, batch.id AS memory_id,
        strpos(batch.normalized_text, fragments.text) AS source_position
    FROM batch CROSS JOIN LATERAL (
        SELECT id, text, ctid AS tuple_id FROM public.fragments
        WHERE memory_id = batch.id ORDER BY id LIMIT 65
    ) AS fragments
), known AS (
    SELECT memory_id FROM positions GROUP BY memory_id
    HAVING min(source_position) > 0 AND count(*) <= 64
       AND count(DISTINCT source_position) = count(*)
), ordered AS (
    SELECT positions.id, positions.tuple_id,
        (row_number() OVER (PARTITION BY positions.memory_id ORDER BY source_position) - 1)::integer AS fragment_index
    FROM positions JOIN known USING (memory_id)
), updated AS (
    UPDATE public.fragments AS fragments SET fragment_index = ordered.fragment_index
        FROM ordered WHERE ordered.tuple_id = fragments.ctid AND fragments.fragment_index IS NULL
            AND fragments.ctid = ANY (ARRAY(SELECT tuple_id FROM ordered))
    RETURNING fragments.id
)
SELECT count(*), max(id::text)::uuid, $2::uuid FROM batch;
