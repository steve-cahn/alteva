CREATE TABLE jobs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    url              text        NOT NULL,
    start_host       text        NOT NULL,
    max_depth        integer     NOT NULL DEFAULT 2   CHECK (max_depth >= 0),
    max_pages        integer     NOT NULL DEFAULT 200 CHECK (max_pages > 0),
    status           text        NOT NULL DEFAULT 'Pending'
                     CHECK (status IN ('Pending', 'Running', 'Completed', 'Failed', 'Canceled')),
    failure_reason   text,
    pages_discovered integer     NOT NULL DEFAULT 0,
    pages_processed  integer     NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    completed_at     timestamptz
);

-- History: most recent first.
CREATE INDEX jobs_created_at_idx ON jobs (created_at DESC);

-- One row per normalized URL per job. The unique key is the idempotency anchor:
-- a redelivered message can never create a second row for the same page.
CREATE TABLE pages (
    id                bigserial PRIMARY KEY,
    job_id            uuid    NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    normalized_url    text    NOT NULL,
    parent_page_id    bigint  REFERENCES pages (id) ON DELETE CASCADE,
    depth             integer NOT NULL CHECK (depth >= 0),
    status            text    NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'done', 'skipped', 'failed')),
    domain_link_ratio double precision,
    outgoing_count    integer,
    internal_count    integer,
    http_status       integer,
    error             text,
    processed_at      timestamptz,
    UNIQUE (job_id, normalized_url)
);

-- Completion check ("any page still queued?") and per-status progress counts.
CREATE INDEX pages_job_status_idx ON pages (job_id, status);
-- Tree assembly walks children by parent.
CREATE INDEX pages_parent_idx ON pages (parent_page_id);

-- Every outgoing link of a crawled page. The primary key makes inserts idempotent.
-- to_url is a URL, not a page id: links beyond max depth or max pages have no page row.
CREATE TABLE edges (
    job_id       uuid   NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    from_page_id bigint NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    to_url       text   NOT NULL,
    PRIMARY KEY (job_id, from_page_id, to_url)
);
