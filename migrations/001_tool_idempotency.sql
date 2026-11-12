create table tool_idempotency (
  idempotency_key text primary key,
  body_sha256 bytea not null,
  state text not null check (state in ('started', 'done')),
  response jsonb,
  created_at timestamptz not null default now(),
  check (octet_length(body_sha256) = 32),
  check (
    (state = 'started' and response is null)
    or (state = 'done' and response is not null)
  )
);

create index tool_idempotency_created_idx on tool_idempotency (created_at);
