CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.memories (
    id UUID PRIMARY KEY,
    agent_id TEXT NOT NULL CHECK (octet_length(agent_id) BETWEEN 1 AND 256 AND agent_id !~ '^[[:space:]]*$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_text TEXT NOT NULL CHECK (octet_length(raw_text) BETWEEN 1 AND 32768 AND raw_text !~ '^[[:space:]]*$')
);

CREATE TABLE IF NOT EXISTS public.fragments (
    id UUID PRIMARY KEY,
    memory_id UUID NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
    text TEXT NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 4096 AND text !~ '^[[:space:]]*$'),
    embedding vector({dimensions}) NOT NULL CHECK (vector_norm(embedding) > 0),
    importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1)
);

CREATE TABLE IF NOT EXISTS public.relationships (
    source_fragment UUID NOT NULL REFERENCES public.fragments(id) ON DELETE CASCADE,
    target_fragment UUID NOT NULL REFERENCES public.fragments(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL CHECK (relationship_type IN ('supports', 'contradicts', 'related')),
    PRIMARY KEY (source_fragment, target_fragment, relationship_type),
    CHECK (source_fragment <> target_fragment)
);

CREATE INDEX IF NOT EXISTS memories_agent_id_idx ON public.memories(agent_id);
CREATE INDEX IF NOT EXISTS fragments_memory_id_idx ON public.fragments(memory_id);
CREATE INDEX IF NOT EXISTS relationships_target_idx ON public.relationships(target_fragment);
