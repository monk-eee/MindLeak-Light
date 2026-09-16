ALTER TABLE public.fragments ALTER COLUMN embedding DROP NOT NULL;

CREATE INDEX IF NOT EXISTS fragments_search_idx
    ON public.fragments USING GIN (to_tsvector('english', text));
