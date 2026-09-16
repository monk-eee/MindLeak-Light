DO $$ BEGIN
    IF (
        SELECT count(*) FROM pg_attribute
        WHERE attrelid = 'public.memories'::regclass AND NOT attisdropped
            AND attname IN ('request_id', 'request_payload', 'write_result')
    ) <> 3 THEN
        ALTER TABLE public.memories
            ADD COLUMN IF NOT EXISTS request_id UUID,
            ADD COLUMN IF NOT EXISTS request_payload JSONB,
            ADD COLUMN IF NOT EXISTS write_result JSONB;
    END IF;
    IF to_regclass('public.memories_agent_request_idx') IS NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS memories_agent_request_idx
            ON public.memories (agent_id, request_id) WHERE request_id IS NOT NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.memories'::regclass AND conname = 'memories_write_receipt_check'
    ) THEN
        ALTER TABLE public.memories ADD CONSTRAINT memories_write_receipt_check CHECK (
            (request_id IS NULL AND request_payload IS NULL AND write_result IS NULL)
            OR (request_id IS NOT NULL AND request_payload IS NOT NULL AND write_result IS NOT NULL)
        );
    END IF;
END $$;
