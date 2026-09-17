BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL intervalstyle = 'postgres';
LOCK TABLE public.memories, public.fragments, public.relationships IN ACCESS SHARE MODE;
SELECT jsonb_build_object(
    'snapshot', pg_export_snapshot(),
    'version', current_setting('server_version'),
    'bytes', pg_database_size(current_database()),
    'tables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
    'binding', obj_description('public.fragments'::regclass),
    'settings', (SELECT json_build_object('encoding', pg_encoding_to_char(encoding),
        'collate', datcollate, 'ctype', datctype, 'provider', datlocprovider,
        'icuLocale', daticulocale) FROM pg_database WHERE datname = current_database()),
    'extensions', (SELECT json_agg(json_build_object('name', extname, 'version', extversion)
        ORDER BY extname) FROM pg_extension),
    'schema', json_build_object(
        'columns', (SELECT json_agg(definition ORDER BY relation, attribute_number) FROM (
            SELECT class.relname AS relation, attribute.attnum AS attribute_number,
                attribute.attname AS name, format_type(attribute.atttypid, attribute.atttypmod) AS type,
                attribute.attnotnull AS not_null, attribute.attidentity AS identity,
                attribute.attgenerated AS generated, pg_get_expr(defaults.adbin, defaults.adrelid) AS default_value,
                collation_def.collname AS collation_name
            FROM pg_attribute attribute JOIN pg_class class ON class.oid = attribute.attrelid
            JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
            LEFT JOIN pg_attrdef defaults ON defaults.adrelid = class.oid AND defaults.adnum = attribute.attnum
            LEFT JOIN pg_collation collation_def ON collation_def.oid = attribute.attcollation
            WHERE namespace.nspname = 'public' AND class.relkind = 'r'
                AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ) definition),
        'constraints', (SELECT json_agg(definition ORDER BY relation, name) FROM (
            SELECT class.relname AS relation, constraint_def.conname AS name,
                pg_get_constraintdef(constraint_def.oid, true) AS definition
            FROM pg_constraint constraint_def JOIN pg_class class ON class.oid = constraint_def.conrelid
            JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
            WHERE namespace.nspname = 'public'
        ) definition),
        'indexes', (SELECT json_agg(json_build_object('name', indexname, 'definition', indexdef)
            ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'),
        'triggers', (SELECT json_agg(definition ORDER BY relation, name) FROM (
            SELECT class.relname AS relation, trigger_def.tgname AS name, trigger_def.tgenabled AS enabled,
                pg_get_triggerdef(trigger_def.oid) AS definition
            FROM pg_trigger trigger_def JOIN pg_class class ON class.oid = trigger_def.tgrelid
            JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
            WHERE namespace.nspname = 'public' AND NOT trigger_def.tgisinternal
        ) definition),
        'functions', (SELECT json_agg(definition ORDER BY name, arguments) FROM (
            SELECT procedure.proname AS name, pg_get_function_identity_arguments(procedure.oid) AS arguments,
                pg_get_functiondef(procedure.oid) AS definition
            FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public' AND procedure.prokind IN ('f', 'p')
                AND NOT EXISTS (SELECT 1 FROM pg_depend dependency
                    WHERE dependency.classid = 'pg_proc'::regclass AND dependency.objid = procedure.oid
                        AND dependency.deptype = 'e')
        ) definition)
    ),
    'canary', (SELECT json_build_object('fragmentId', fragment.id, 'agentId', memory.agent_id,
        'scope', memory.context->>'scope', 'rawSha256', encode(sha256(convert_to(memory.raw_text, 'UTF8')), 'hex'),
        'query', (SELECT term FROM unnest(tsvector_to_array(fragment.search_vector)) term
            ORDER BY length(term) DESC, term LIMIT 1))
        FROM public.fragments fragment JOIN public.memories memory ON memory.id = fragment.memory_id
        WHERE fragment.state = 'active' AND to_jsonb(memory)->>'chain_id' IS NULL
        ORDER BY fragment.id LIMIT 1),
    'knowledgeCanary', (SELECT json_build_object(
        'chainId', to_jsonb(memory)->>'chain_id',
        'revision', (to_jsonb(memory)->>'chain_revision')::integer,
        'scope', memory.context->>'scope',
        'rawSha256', encode(sha256(convert_to(memory.raw_text, 'UTF8')), 'hex'),
        'claimSha256', encode(sha256(convert_to(to_jsonb(memory)->'chain_snapshot'->'document'->>'claim', 'UTF8')), 'hex'))
        FROM public.memories memory WHERE (to_jsonb(memory)->>'chain_current')::boolean
        ORDER BY (to_jsonb(memory)->'chain_snapshot'->'document'->>'kind' = 'principle') DESC, memory.id LIMIT 1)
);
