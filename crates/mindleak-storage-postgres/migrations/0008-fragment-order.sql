DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND attname = 'fragment_index'
          AND NOT attisdropped
    ) THEN
        ALTER TABLE public.fragments ADD COLUMN fragment_index INTEGER
            CHECK (fragment_index BETWEEN 0 AND 63);
        WITH positions AS (
            SELECT fragments.id, fragments.memory_id,
                strpos(regexp_replace(memories.raw_text, '[[:space:]]+', ' ', 'g'), fragments.text) AS source_position
            FROM public.fragments AS fragments
            JOIN public.memories AS memories ON memories.id = fragments.memory_id
        ), known AS (
            SELECT memory_id FROM positions GROUP BY memory_id
            HAVING min(source_position) > 0 AND count(*) <= 64
               AND count(DISTINCT source_position) = count(*)
        ), ordered AS (
            SELECT positions.id,
                (row_number() OVER (PARTITION BY positions.memory_id ORDER BY source_position) - 1)::integer AS fragment_index
            FROM positions JOIN known USING (memory_id)
        )
        UPDATE public.fragments AS fragments SET fragment_index = ordered.fragment_index
        FROM ordered WHERE ordered.id = fragments.id;
    END IF;
    IF to_regclass('public.fragments_document_order_idx') IS NULL THEN
        CREATE INDEX fragments_document_order_idx
            ON public.fragments(memory_id, fragment_index, id);
    END IF;
END
$migration$;
