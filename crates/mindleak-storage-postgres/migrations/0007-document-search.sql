DO $migration$
BEGIN
    IF to_regprocedure('public.mindleak_document_vector(text,jsonb)') IS NULL THEN
        CREATE FUNCTION public.mindleak_document_vector(fragment_text TEXT, source_context JSONB)
        RETURNS TSVECTOR
        LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE
        SET search_path = pg_catalog
        AS $function$
            SELECT setweight(public.mindleak_keyword_vector(fragment_text), 'C') ||
                setweight(public.mindleak_keyword_vector(
                    COALESCE(source_context->>'source', '') || ' ' ||
                    COALESCE(source_context->>'summary', '')
                ) || to_tsvector('pg_catalog.english', regexp_replace(
                    COALESCE(source_context->>'source', ''), '[[:punct:]]+', ' ', 'g'
                )), 'D')
        $function$;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND attname = 'search_vector'
          AND NOT attisdropped
    ) THEN
        ALTER TABLE public.fragments ADD COLUMN search_vector TSVECTOR;
    END IF;
    IF to_regprocedure('public.mindleak_fragment_search_vector()') IS NULL THEN
        CREATE FUNCTION public.mindleak_fragment_search_vector()
        RETURNS TRIGGER LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $function$
        BEGIN
            SELECT public.mindleak_document_vector(NEW.text, context)
            INTO NEW.search_vector FROM public.memories WHERE id = NEW.memory_id;
            RETURN NEW;
        END
        $function$;
    END IF;
    IF to_regprocedure('public.mindleak_memory_search_vectors()') IS NULL THEN
        CREATE FUNCTION public.mindleak_memory_search_vectors()
        RETURNS TRIGGER LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $function$
        BEGIN
            UPDATE public.fragments
            SET search_vector = public.mindleak_document_vector(text, NEW.context)
            WHERE memory_id = NEW.id;
            RETURN NEW;
        END
        $function$;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.fragments'::regclass AND tgname = 'fragments_search_vector'
    ) THEN
        CREATE TRIGGER fragments_search_vector BEFORE INSERT OR UPDATE OF text, memory_id
            ON public.fragments FOR EACH ROW
            EXECUTE FUNCTION public.mindleak_fragment_search_vector();
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.memories'::regclass AND tgname = 'memories_search_vectors'
    ) THEN
        CREATE TRIGGER memories_search_vectors AFTER UPDATE OF context
            ON public.memories FOR EACH ROW
            WHEN ((OLD.context->>'source') IS DISTINCT FROM (NEW.context->>'source')
               OR (OLD.context->>'summary') IS DISTINCT FROM (NEW.context->>'summary'))
            EXECUTE FUNCTION public.mindleak_memory_search_vectors();
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.fragments'::regclass AND attname = 'search_vector'
          AND NOT attnotnull AND NOT attisdropped
    ) THEN
        UPDATE public.fragments AS fragments
        SET search_vector = public.mindleak_document_vector(fragments.text, memories.context)
        FROM public.memories AS memories
        WHERE memories.id = fragments.memory_id AND fragments.search_vector IS NULL;
        ALTER TABLE public.fragments ALTER COLUMN search_vector SET NOT NULL;
    END IF;
    IF to_regclass('public.fragments_document_search_idx') IS NULL THEN
        CREATE INDEX fragments_document_search_idx ON public.fragments USING GIN (search_vector);
    END IF;
    IF to_regclass('public.fragments_identifier_search_idx') IS NOT NULL THEN
        DROP INDEX public.fragments_identifier_search_idx;
    END IF;
    IF to_regclass('public.fragments_search_idx') IS NOT NULL THEN
        DROP INDEX public.fragments_search_idx;
    END IF;
END
$migration$;
