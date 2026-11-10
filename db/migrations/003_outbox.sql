-- Transactional outbox. A process that must send a message writes a row here in the SAME transaction
-- as the state change that caused it; a relay publishes the rows to the broker afterwards. The
-- state and its message therefore commit together or not at all: a crash can no longer leave a
-- page 'queued' with no message, or a message that refers to rolled-back data.
CREATE TABLE outbox (
    id           bigserial   PRIMARY KEY,
    message_id   uuid        NOT NULL UNIQUE,
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    attempts     integer     NOT NULL DEFAULT 0,
    last_error   text
);

-- The relay only ever looks at unpublished rows, oldest first: keep that index tiny.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
-- Old published rows are deleted by the relay; this makes that delete an index range scan.
CREATE INDEX outbox_published_at_idx ON outbox (published_at) WHERE published_at IS NOT NULL;
