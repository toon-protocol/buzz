-- Full-text search never reflected message edits (kind:40003, buzz#129): the
-- original message row's `content` (and therefore its GENERATED search_tsv)
-- is written once at insert time and never touched again, so an edit's new
-- text was unsearchable and the pre-edit text stayed indexed forever.
--
-- Editing a message never rewrites the original row's signed `content`
-- column in place — that column is part of the event's signature, and
-- mutating it would invalidate provenance for the aux-closure overlay design
-- (see docs/bridge-channel-window.md). Instead, add a plain, non-generated
-- `edit_content` column that the edit-ingest path updates out of band, and
-- make search_tsv prefer it over `content` when present.
--
-- PostgreSQL cannot alter a generated expression in place. Capture the
-- current expression before replacing the column (mirrors migration 0014),
-- so this composes with whatever allowlist/exclusion expression an
-- installation is currently on.
ALTER TABLE events ADD COLUMN edit_content TEXT;

DO $$
DECLARE
    existing_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO existing_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid
       AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass
       AND a.attname = 'search_tsv';

    IF existing_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found';
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN edit_content IS NOT NULL THEN to_tsvector(''simple'', edit_content) ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
