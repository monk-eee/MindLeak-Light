DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memories'::regclass AND attname = 'chain_id' AND NOT attisdropped) THEN
        ALTER TABLE public.memories
            ADD COLUMN chain_id UUID,
            ADD COLUMN chain_revision INTEGER,
            ADD COLUMN chain_current BOOLEAN,
            ADD COLUMN chain_snapshot JSONB,
            ADD COLUMN chain_operation TEXT,
            ADD COLUMN chain_previous_id UUID REFERENCES public.memories(id),
            ADD COLUMN chain_claim_key TEXT,
            ADD COLUMN chain_search TSVECTOR,
            ADD COLUMN chain_embedding vector,
            ADD CONSTRAINT memories_chain_record_check CHECK ((
                (chain_id IS NULL AND chain_revision IS NULL AND chain_current IS NULL
                 AND chain_snapshot IS NULL AND chain_operation IS NULL AND chain_previous_id IS NULL
                 AND chain_claim_key IS NULL AND chain_search IS NULL AND chain_embedding IS NULL)
                OR
                (chain_id IS NOT NULL AND chain_revision > 0 AND chain_current IS NOT NULL
                 AND chain_snapshot IS NOT NULL AND jsonb_typeof(chain_snapshot) = 'object'
                 AND chain_snapshot->>'state' IN ('candidate', 'accepted', 'retired')
                 AND chain_snapshot->>'review' IN ('unreviewed', 'reviewed', 'challenged')
                 AND chain_operation IN ('propose', 'accept', 'challenge', 'revise', 'retire')
                 AND request_id IS NOT NULL AND chain_claim_key IS NOT NULL AND chain_search IS NOT NULL
                 AND ((chain_revision = 1 AND chain_previous_id IS NULL AND chain_operation = 'propose')
                      OR (chain_revision > 1 AND chain_previous_id IS NOT NULL)))
            ) IS TRUE);
        CREATE UNIQUE INDEX memories_chain_revision_idx ON public.memories (chain_id, chain_revision) WHERE chain_id IS NOT NULL;
        CREATE UNIQUE INDEX memories_chain_head_idx ON public.memories (chain_id) WHERE chain_current;
        CREATE UNIQUE INDEX memories_chain_claim_idx ON public.memories ((COALESCE(context->>'scope', '')), chain_claim_key)
            WHERE chain_current AND chain_snapshot->>'state' <> 'retired';
        CREATE INDEX memories_chain_search_idx ON public.memories USING GIN (chain_search) WHERE chain_current;
        CREATE INDEX memories_chain_dependencies_idx ON public.memories USING GIN ((chain_snapshot->'document'->'supportedBy') jsonb_path_ops) WHERE chain_current;
    END IF;
END
$$;
