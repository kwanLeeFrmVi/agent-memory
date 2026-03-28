-- Agent Memory Schema
-- Paste this entire file into Supabase SQL Editor and run it.
--
-- IMPORTANT: Change 768 to match your embedding model's dimension:
--   Ollama mxbai-embed-large  → 768
--   Ollama nomic-embed-text   → 768
--   OpenAI text-embedding-3-small → 1536
--   OpenAI text-embedding-3-large → 3072
--   Cohere embed-english-v3.0     → 768
--   Voyage voyage-code-2          → 1536
--   Voyage voyage-3               → 768
--   Google gemini-embedding-001   → 768

-- ============================================================
-- 0. Extension
-- ============================================================
create extension if not exists vector with schema extensions;

-- ============================================================
-- 1. Memories table
-- ============================================================
create table if not exists memories (
  id               uuid primary key default gen_random_uuid(),
  content          text not null,
  original_content text,                       -- preserved before compression
  embedding        extensions.vector(768),   -- change 768 to your dim
  embedding_model  text,                       -- which model generated this vector
  source           text,                       -- e.g. 'claude-code', 'cursor'
  profile          text default 'default',     -- namespace partition
  tags             text[] default '{}',
  metadata         jsonb default '{}',
  confidence       float default 0.8 check (confidence >= 0 and confidence <= 1),
  access_count     int default 0,
  compression_level int default 0 check (compression_level in (0, 1, 2)),
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  expires_at       timestamptz default null    -- null = never expires
);

-- Full-text search column (auto-generated, always up to date)
alter table memories
  add column if not exists search_vector tsvector
  generated always as (to_tsvector('english', content)) stored;

-- Extended fields (added here so functions below can reference them safely)
alter table memories add column if not exists is_pinned boolean default false;
alter table memories add column if not exists importance float default 0.5
  check (importance >= 0 and importance <= 1);

-- ============================================================
-- 2. Indexes
-- ============================================================

-- HNSW index for fast approximate nearest-neighbor vector search
create index if not exists idx_memories_embedding
  on memories using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 128);

-- GIN index for full-text search
create index if not exists idx_memories_fts
  on memories using gin(search_vector);

-- Filtering indexes
create index if not exists idx_memories_profile   on memories(profile);
create index if not exists idx_memories_source    on memories(source);
create index if not exists idx_memories_tags      on memories using gin(tags);
create index if not exists idx_memories_expires   on memories(expires_at) where expires_at is not null;
create index if not exists idx_memories_created   on memories(created_at desc);
create index if not exists idx_memories_profile_created on memories(profile, created_at desc);

-- ============================================================
-- 3. Knowledge graph edges table
-- ============================================================
create table if not exists memory_edges (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null references memories(id) on delete cascade,
  target_id   uuid not null references memories(id) on delete cascade,
  edge_type   text not null,     -- supports | contradicts | expands | related | depends_on | similar
  strength    float default 0.5 check (strength >= 0 and strength <= 1),
  properties  jsonb default '{}',
  created_at  timestamptz default now(),
  constraint  no_self_loops check (source_id != target_id)
);

-- Unique edge per (source, target, type) pair
create unique index if not exists idx_memory_edges_unique
  on memory_edges(source_id, target_id, edge_type);

create index if not exists idx_memory_edges_source on memory_edges(source_id);
create index if not exists idx_memory_edges_target on memory_edges(target_id);
create index if not exists idx_memory_edges_type   on memory_edges(edge_type);

-- ============================================================
-- 4. Auto-update updated_at trigger
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists memories_updated_at on memories;
create trigger memories_updated_at
  before update on memories
  for each row execute function update_updated_at();

-- ============================================================
-- 5. RPC: match_memories (pure semantic search)
-- ============================================================
drop function if exists match_memories(extensions.vector, float, int, text, text, float);
drop function if exists match_memories(extensions.vector, float, int, text[], text, text);
create or replace function match_memories(
  query_embedding   extensions.vector,
  match_threshold   float    default 0.3,
  match_count       int      default 10,
  profile_filter    text     default null,
  source_filter     text     default null,
  min_confidence    float    default 0,
  after_date        timestamptz default null,
  before_date       timestamptz default null
)
returns table (
  id          uuid,
  content     text,
  similarity  float,
  metadata    jsonb,
  tags        text[],
  source      text,
  confidence  float,
  created_at  timestamptz
)
language sql stable as $$
  select
    id, content,
    1 - (embedding <=> query_embedding) as similarity,
    metadata, tags, source, confidence, created_at
  from memories
  where (expires_at is null or expires_at > now())
    and (profile_filter is null or profile = profile_filter)
    and (source_filter  is null or source  = source_filter)
    and confidence >= min_confidence
    and (after_date is null or created_at >= after_date)
    and (before_date is null or created_at <= before_date)
    and (1 - (embedding <=> query_embedding)) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- 6. RPC: hybrid_search (semantic + keyword, RRF ranked)
-- ============================================================
drop function if exists hybrid_search(text, extensions.vector, int, float, int, text, text, text, float);
drop function if exists hybrid_search(text, extensions.vector, int, float, int, text, text, text, float, timestamptz, timestamptz);
create or replace function hybrid_search(
  query_text        text,
  query_embedding   extensions.vector,
  match_count       int      default 10,
  match_threshold   float    default 0.3,
  rrf_k             int      default 60,
  profile_filter    text     default null,
  source_filter     text     default null,
  tag_filter        text     default null,
  min_confidence    float    default 0,
  after_date        timestamptz default null,
  before_date       timestamptz default null,
  pinned_only       boolean  default false,
  min_importance    float    default 0
)
returns table (
  id             uuid,
  content        text,
  rrf_score      float,
  semantic_rank  int,
  keyword_rank   int,
  metadata       jsonb,
  tags           text[],
  source         text,
  confidence     float,
  is_pinned      boolean,
  importance     float,
  created_at     timestamptz
)
language sql stable as $$
  with base as (
    select * from memories
    where (expires_at is null or expires_at > now())
      and (profile_filter is null or profile = profile_filter)
      and (source_filter  is null or source  = source_filter)
      and (tag_filter     is null or tag_filter = any(tags))
      and confidence >= min_confidence
      and (after_date is null or created_at >= after_date)
      and (before_date is null or created_at <= before_date)
      and (not pinned_only or is_pinned = true)
      and importance >= min_importance
  ),
  semantic as (
    select id,
           row_number() over (order by embedding <=> query_embedding) as rank
    from base
    where (1 - (embedding <=> query_embedding)) > match_threshold
    limit match_count
  ),
  keyword as (
    select id,
           row_number() over (order by ts_rank(search_vector, plainto_tsquery('english', query_text)) desc) as rank
    from base
    where search_vector @@ plainto_tsquery('english', query_text)
    limit match_count
  ),
  rrf as (
    select
      coalesce(s.id, k.id) as id,
      coalesce(1.0::float / (rrf_k + s.rank), 0)
      + coalesce(1.0::float / (rrf_k + k.rank), 0) as rrf_score,
      s.rank::int as semantic_rank,
      k.rank::int as keyword_rank
    from semantic s
    full outer join keyword k on s.id = k.id
  )
  select
    m.id, m.content,
    r.rrf_score, r.semantic_rank, r.keyword_rank,
    m.metadata, m.tags, m.source, m.confidence,
    m.is_pinned, m.importance, m.created_at
  from rrf r
  join base m on m.id = r.id
  order by r.rrf_score desc
  limit match_count;
$$;

-- ============================================================
-- 7. RPC: find_related_memories (graph traversal)
-- ============================================================
create or replace function find_related_memories(
  start_memory_id  uuid,
  max_depth        int   default 2,
  min_strength     float default 0.5
)
returns table (
  memory_id   uuid,
  content     text,
  depth       int,
  edge_type   text,
  strength    float,
  path        text[]
)
language sql stable as $$
  with recursive traversal as (
    -- base case: starting node
    select
      m.id                       as memory_id,
      m.content,
      0                          as depth,
      'root'::text               as edge_type,
      1.0::float                 as strength,
      array[m.id::text]          as path
    from memories m
    where m.id = start_memory_id

    union all

    -- recursive: follow edges in both directions
    select
      next_m.id,
      next_m.content,
      t.depth + 1,
      e.edge_type,
      e.strength,
      t.path || next_m.id::text
    from traversal t
    join memory_edges e on
      (e.source_id = t.memory_id or e.target_id = t.memory_id)
    join memories next_m on
      next_m.id = case
        when e.source_id = t.memory_id then e.target_id
        else e.source_id
      end
    where t.depth < max_depth
      and e.strength >= min_strength
      and next_m.id::text != all(t.path)  -- no cycles
  )
  select memory_id, content, depth, edge_type, strength, path
  from traversal
  order by depth, strength desc;
$$;

-- ============================================================
-- 8. RPC: get_memories_by_tag
-- ============================================================
create or replace function get_memories_by_tag(
  tag             text,
  limit_count     int  default 20,
  profile_filter  text default null
)
returns table (
  id          uuid,
  content     text,
  tags        text[],
  metadata    jsonb,
  source      text,
  confidence  float,
  created_at  timestamptz
)
language sql stable as $$
  select id, content, tags, metadata, source, confidence, created_at
  from memories
  where tag = any(tags)
    and (expires_at is null or expires_at > now())
    and (profile_filter is null or profile = profile_filter)
  order by created_at desc
  limit limit_count;
$$;

-- ============================================================
-- 9. RPC: cleanup_expired_memories
-- ============================================================
create or replace function cleanup_expired_memories()
returns int
language plpgsql as $$
declare
  deleted_count int;
begin
  delete from memories where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- ============================================================
-- 10. RPC: bump_access_count (VOLATILE — separated from STABLE search)
-- ============================================================
create or replace function bump_access_count(memory_ids uuid[])
returns void
language plpgsql as $$
begin
  update memories set access_count = access_count + 1
  where id = any(memory_ids);
end;
$$;

-- ============================================================
-- 11. RPC: memory_stats (aggregate stats without fetching rows)
-- ============================================================
create or replace function memory_stats(profile_filter text default null)
returns json
language sql stable as $$
  select json_build_object(
    'total', (select count(*) from memories where (profile_filter is null or profile = profile_filter) and (expires_at is null or expires_at > now())),
    'by_source', (select coalesce(json_object_agg(s, cnt), '{}') from (select coalesce(source, 'unknown') as s, count(*) as cnt from memories where (profile_filter is null or profile = profile_filter) and (expires_at is null or expires_at > now()) group by source) t),
    'by_profile', (select coalesce(json_object_agg(p, cnt), '{}') from (select coalesce(profile, 'default') as p, count(*) as cnt from memories where (expires_at is null or expires_at > now()) group by profile) t),
    'expiring_in_7d', (select count(*) from memories where expires_at is not null and expires_at > now() and expires_at <= now() + interval '7 days' and (profile_filter is null or profile = profile_filter)),
    'edge_count_by_type', (select coalesce(json_object_agg(et, cnt), '{}') from (select edge_type as et, count(*) as cnt from memory_edges group by edge_type) t),
    'orphan_count', (select count(*) from memories m where (profile_filter is null or m.profile = profile_filter) and (m.expires_at is null or m.expires_at > now()) and m.id not in (select source_id from memory_edges) and m.id not in (select target_id from memory_edges)),
    'top_accessed', (select coalesce(json_agg(row_to_json(t)), '[]') from (select id, content, access_count from memories where (profile_filter is null or profile = profile_filter) and (expires_at is null or expires_at > now()) order by access_count desc limit 5) t),
    'pinned_count', (select count(*) from memories where (profile_filter is null or profile = profile_filter) and (expires_at is null or expires_at > now()) and is_pinned = true),
    'avg_confidence', (select round(avg(confidence)::numeric, 3) from memories where (profile_filter is null or profile = profile_filter) and (expires_at is null or expires_at > now()))
  );
$$;

-- ============================================================
-- 12. Indexes and tables for new fields
-- ============================================================

create index if not exists idx_memories_importance on memories(importance);
create index if not exists idx_memories_pinned on memories(is_pinned) where is_pinned = true;

-- Profile-level settings (e.g. default TTL)
create table if not exists profile_settings (
  profile     text primary key,
  ttl_days    int default null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

drop trigger if exists profile_settings_updated_at on profile_settings;
create trigger profile_settings_updated_at
  before update on profile_settings
  for each row execute function update_updated_at();
