DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND attname = 'embedding'
          AND attnotnull AND NOT attisdropped
    ) THEN
        ALTER TABLE public.fragments ALTER COLUMN embedding DROP NOT NULL;
    END IF;
    IF to_regclass('public.fragments_search_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS fragments_search_idx
            ON public.fragments USING GIN (to_tsvector('english', text));
    END IF;
END
$$;
