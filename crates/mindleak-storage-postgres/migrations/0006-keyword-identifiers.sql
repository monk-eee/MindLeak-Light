DO $migration$
BEGIN
    IF to_regprocedure('public.mindleak_keyword_vector(text)') IS NULL THEN
        CREATE FUNCTION public.mindleak_keyword_vector(source_text TEXT)
        RETURNS TSVECTOR
        LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE
        SET search_path = pg_catalog
        AS $function$
            SELECT to_tsvector('pg_catalog.english', source_text) || COALESCE(
                (
                    SELECT to_tsvector('pg_catalog.english', string_agg(replace(token, '.', ' '), ' '))
                    FROM ts_debug('pg_catalog.english', source_text)
                    WHERE alias = 'host'
                      AND token ~ '^[[:alpha:]_][[:alnum:]_]*(\.[[:alpha:]_][[:alnum:]_]*)+$'
                ),
                ''::tsvector
            )
        $function$;
    END IF;
END
$migration$;
