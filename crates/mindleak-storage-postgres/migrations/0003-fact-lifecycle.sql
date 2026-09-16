DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.memories'::regclass AND attname = 'context' AND NOT attisdropped
    ) THEN
        ALTER TABLE public.memories ADD COLUMN context JSONB NOT NULL DEFAULT '{}';
    END IF;

    IF (
        SELECT count(*) FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND NOT attisdropped
          AND attname IN ('tier', 'state', 'evidence', 'pinned', 'useful_sessions',
                          'confirmed_sessions', 'reinforced_at', 'first_evidence_at')
    ) <> 8 THEN
        ALTER TABLE public.fragments
            ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'short_term' CHECK (tier IN ('short_term', 'long_term')),
            ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'superseded')),
            ADD COLUMN IF NOT EXISTS evidence TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (evidence IN ('unconfirmed', 'confirmed', 'disputed')),
            ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS useful_sessions INTEGER NOT NULL DEFAULT 0 CHECK (useful_sessions >= 0),
            ADD COLUMN IF NOT EXISTS confirmed_sessions INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_sessions >= 0),
            ADD COLUMN IF NOT EXISTS reinforced_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS first_evidence_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.relationships'::regclass AND attname = 'evidence_session' AND NOT attisdropped
    ) THEN
        ALTER TABLE public.relationships ADD COLUMN evidence_session TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'public.relationships'::regclass
        AND conname = 'relationships_lifecycle_type_check'
    ) THEN
        ALTER TABLE public.relationships DROP CONSTRAINT relationships_relationship_type_check;
        ALTER TABLE public.relationships ADD CONSTRAINT relationships_lifecycle_type_check CHECK (
            relationship_type IN ('supports', 'contradicts', 'related', 'reinforces', 'confirms', 'supersedes', 'archives', 'restores')
        );
        ALTER TABLE public.relationships ADD CONSTRAINT relationships_evidence_session_check CHECK (
            (relationship_type IN ('reinforces', 'confirms') AND evidence_session IS NOT NULL AND octet_length(evidence_session) BETWEEN 1 AND 256)
            OR (relationship_type NOT IN ('reinforces', 'confirms') AND evidence_session IS NULL)
        );
    END IF;
    IF to_regclass('public.relationships_feedback_session_idx') IS NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS relationships_feedback_session_idx
            ON public.relationships(target_fragment, relationship_type, evidence_session)
            WHERE evidence_session IS NOT NULL;
    END IF;
    IF to_regclass('public.memories_context_scope_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS memories_context_scope_idx ON public.memories ((context->>'scope'));
    END IF;
    IF to_regclass('public.fragments_lifecycle_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS fragments_lifecycle_idx ON public.fragments(state, tier);
    END IF;
END
$$;
