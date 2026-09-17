DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.memories'::regclass AND attname = 'domain_entity' AND NOT attisdropped
    ) THEN
        ALTER TABLE public.memories ADD COLUMN domain_entity JSONB;
        ALTER TABLE public.memories ADD CONSTRAINT memories_domain_entity_check CHECK (
            domain_entity IS NULL OR COALESCE(
                jsonb_typeof(domain_entity) = 'object'
                AND domain_entity->>'kind' = 'entity'
                AND jsonb_typeof(domain_entity->'identity') = 'object'
                AND jsonb_typeof(domain_entity #> '{identity,namespace}') = 'string'
                AND jsonb_typeof(domain_entity #> '{identity,id}') = 'string'
                AND octet_length(domain_entity #>> '{identity,namespace}') BETWEEN 1 AND 256
                AND octet_length(domain_entity #>> '{identity,id}') BETWEEN 1 AND 256
                AND jsonb_typeof(domain_entity->'label') = 'string'
                AND octet_length(domain_entity->>'label') BETWEEN 1 AND 1024
                AND jsonb_typeof(domain_entity->'entityType') = 'string'
                AND octet_length(domain_entity->>'entityType') BETWEEN 1 AND 256,
                FALSE
            )
        );
        CREATE UNIQUE INDEX memories_domain_entity_identity_idx ON public.memories
            ((domain_entity #>> '{identity,namespace}'), (domain_entity #>> '{identity,id}'))
            WHERE domain_entity IS NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.relationships'::regclass AND attname = 'edge_memory_id' AND NOT attisdropped
    ) THEN
        ALTER TABLE public.relationships DROP CONSTRAINT relationships_pkey;
        ALTER TABLE public.relationships
            ALTER COLUMN source_fragment DROP NOT NULL,
            ALTER COLUMN target_fragment DROP NOT NULL,
            ALTER COLUMN relationship_type DROP NOT NULL,
            ADD COLUMN edge_memory_id UUID REFERENCES public.memories(id) ON DELETE CASCADE,
            ADD COLUMN source_entity UUID REFERENCES public.memories(id) ON DELETE CASCADE,
            ADD COLUMN target_entity UUID REFERENCES public.memories(id) ON DELETE CASCADE,
            ADD COLUMN domain_namespace TEXT,
            ADD COLUMN domain_id TEXT,
            ADD COLUMN predicate TEXT,
            ADD COLUMN provenance JSONB;
        ALTER TABLE public.relationships ADD CONSTRAINT relationships_kind_check CHECK (
            (source_fragment IS NOT NULL AND target_fragment IS NOT NULL AND relationship_type IS NOT NULL
             AND edge_memory_id IS NULL AND source_entity IS NULL AND target_entity IS NULL
             AND domain_namespace IS NULL AND domain_id IS NULL AND predicate IS NULL AND provenance IS NULL)
            OR
            (source_fragment IS NULL AND target_fragment IS NULL AND relationship_type IS NULL AND evidence_session IS NULL
             AND edge_memory_id IS NOT NULL AND source_entity IS NOT NULL AND target_entity IS NOT NULL
             AND domain_namespace IS NOT NULL AND domain_id IS NOT NULL AND predicate IS NOT NULL AND provenance IS NOT NULL
             AND octet_length(domain_namespace) BETWEEN 1 AND 256 AND octet_length(domain_id) BETWEEN 1 AND 256
             AND octet_length(predicate) BETWEEN 1 AND 256)
        );
        ALTER TABLE public.relationships ADD CONSTRAINT relationships_domain_provenance_check CHECK (
            provenance IS NULL OR COALESCE(
                jsonb_typeof(provenance) = 'object'
                AND jsonb_typeof(provenance->'sourceReferences') = 'array'
                AND jsonb_array_length(provenance->'sourceReferences') BETWEEN 1 AND 8
                AND octet_length(provenance::text) <= 65536
                AND (NOT (provenance ? 'reportedConfidence') OR
                    (jsonb_typeof(provenance->'reportedConfidence') = 'number'
                     AND (provenance->>'reportedConfidence')::double precision BETWEEN 0 AND 1)), FALSE)
        );
        CREATE UNIQUE INDEX relationships_fragment_identity_idx ON public.relationships
            (source_fragment, target_fragment, relationship_type) WHERE source_fragment IS NOT NULL;
        CREATE UNIQUE INDEX relationships_domain_identity_idx ON public.relationships
            (domain_namespace, domain_id) WHERE edge_memory_id IS NOT NULL;
        CREATE UNIQUE INDEX relationships_domain_memory_idx ON public.relationships
            (edge_memory_id) WHERE edge_memory_id IS NOT NULL;
        CREATE INDEX relationships_domain_outgoing_predicate_idx ON public.relationships
            (source_entity, predicate, edge_memory_id) INCLUDE (target_entity) WHERE edge_memory_id IS NOT NULL;
        CREATE INDEX relationships_domain_incoming_predicate_idx ON public.relationships
            (target_entity, predicate, edge_memory_id) INCLUDE (source_entity) WHERE edge_memory_id IS NOT NULL;
    END IF;
    IF to_regclass('public.relationships_domain_outgoing_idx') IS NOT NULL THEN
        DROP INDEX public.relationships_domain_outgoing_idx;
    END IF;
    IF to_regclass('public.relationships_domain_incoming_idx') IS NOT NULL THEN
        DROP INDEX public.relationships_domain_incoming_idx;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.relationships_incoming_context_idx'::regclass AND indpred IS NULL) THEN
        DROP INDEX public.relationships_target_idx;
        DROP INDEX public.relationships_incoming_context_idx;
        DROP INDEX public.relationships_outgoing_context_idx;
        CREATE INDEX relationships_target_idx ON public.relationships(target_fragment) WHERE target_fragment IS NOT NULL;
        CREATE INDEX relationships_incoming_context_idx ON public.relationships (
            target_fragment,
            (CASE relationship_type WHEN 'supersedes' THEN 0 WHEN 'contradicts' THEN 1
                WHEN 'archives' THEN 2 WHEN 'restores' THEN 3 WHEN 'supports' THEN 4
                WHEN 'confirms' THEN 5 WHEN 'reinforces' THEN 6 ELSE 7 END), source_fragment
        ) WHERE target_fragment IS NOT NULL;
        CREATE INDEX relationships_outgoing_context_idx ON public.relationships (
            source_fragment,
            (CASE relationship_type WHEN 'supersedes' THEN 0 WHEN 'contradicts' THEN 1
                WHEN 'archives' THEN 2 WHEN 'restores' THEN 3 WHEN 'supports' THEN 4
                WHEN 'confirms' THEN 5 WHEN 'reinforces' THEN 6 ELSE 7 END), target_fragment
        ) WHERE source_fragment IS NOT NULL;
    END IF;

    IF to_regprocedure('public.mindleak_domain_vector(jsonb)') IS NULL THEN
        CREATE FUNCTION public.mindleak_domain_vector(domain_record JSONB)
        RETURNS TSVECTOR LANGUAGE SQL IMMUTABLE PARALLEL SAFE
        SET search_path = pg_catalog
        AS $function$
            SELECT CASE WHEN domain_record IS NULL THEN ''::tsvector ELSE
                setweight(public.mindleak_keyword_vector(concat_ws(' ',
                    domain_record #>> '{identity,namespace}', domain_record #>> '{identity,id}',
                    domain_record->>'label', domain_record->>'entityType', domain_record->>'predicate',
                    domain_record #>> '{source,namespace}', domain_record #>> '{source,id}',
                    domain_record #>> '{target,namespace}', domain_record #>> '{target,id}',
                    (SELECT string_agg(reference, ' ') FROM jsonb_array_elements_text(
                        COALESCE(domain_record #> '{provenance,sourceReferences}', '[]'::jsonb)
                    ) AS source_refs(reference))
                )), 'D') END
        $function$;
        CREATE OR REPLACE FUNCTION public.mindleak_fragment_search_vector()
        RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog
        AS $function$
        BEGIN
            SELECT public.mindleak_document_vector(NEW.text, context)
                || public.mindleak_domain_vector(request_payload->'domain')
            INTO NEW.search_vector FROM public.memories WHERE id = NEW.memory_id;
            RETURN NEW;
        END
        $function$;
        CREATE OR REPLACE FUNCTION public.mindleak_memory_search_vectors()
        RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog
        AS $function$
        BEGIN
            UPDATE public.fragments SET search_vector = public.mindleak_document_vector(text, NEW.context)
                || public.mindleak_domain_vector(NEW.request_payload->'domain')
            WHERE memory_id = NEW.id;
            RETURN NEW;
        END
        $function$;
        UPDATE public.fragments AS fragments
        SET search_vector = public.mindleak_document_vector(fragments.text, memories.context)
            || public.mindleak_domain_vector(memories.request_payload->'domain')
        FROM public.memories AS memories
        WHERE memories.id = fragments.memory_id AND memories.request_payload ? 'domain';
    END IF;
END
$$;
