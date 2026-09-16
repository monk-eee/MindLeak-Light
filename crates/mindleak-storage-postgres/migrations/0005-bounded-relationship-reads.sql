DO $$ BEGIN
    IF to_regclass('public.relationships_incoming_context_idx') IS NULL THEN
        CREATE INDEX relationships_incoming_context_idx ON public.relationships (
            target_fragment,
            (CASE relationship_type
                WHEN 'supersedes' THEN 0 WHEN 'contradicts' THEN 1
                WHEN 'archives' THEN 2 WHEN 'restores' THEN 3
                WHEN 'supports' THEN 4 WHEN 'confirms' THEN 5
                WHEN 'reinforces' THEN 6 ELSE 7 END),
            source_fragment
        );
    END IF;
    IF to_regclass('public.relationships_outgoing_context_idx') IS NULL THEN
        CREATE INDEX relationships_outgoing_context_idx ON public.relationships (
            source_fragment,
            (CASE relationship_type
                WHEN 'supersedes' THEN 0 WHEN 'contradicts' THEN 1
                WHEN 'archives' THEN 2 WHEN 'restores' THEN 3
                WHEN 'supports' THEN 4 WHEN 'confirms' THEN 5
                WHEN 'reinforces' THEN 6 ELSE 7 END),
            target_fragment
        );
    END IF;
END $$;
