DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND attname = 'fragment_index'
          AND NOT attisdropped
    ) THEN
        ALTER TABLE public.fragments ADD COLUMN fragment_index INTEGER
            CHECK (fragment_index BETWEEN 0 AND 63);
        COMMENT ON COLUMN public.fragments.fragment_index IS
            '{"version":1,"memory_id":null,"fragment_id":null,"completed_rows":0,"elapsed_ms":0,"complete":false}';
    END IF;
END
$migration$;
