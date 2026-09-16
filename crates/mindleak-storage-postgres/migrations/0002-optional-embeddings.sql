DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND attname = 'embedding'
          AND attnotnull AND NOT attisdropped
    ) THEN
        ALTER TABLE public.fragments ALTER COLUMN embedding DROP NOT NULL;
    END IF;
END
$$;
