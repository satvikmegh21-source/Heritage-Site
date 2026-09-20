-- ===========================================================================
-- Cultural Heritage Mapping System — Supabase schema
-- Run this once in your Supabase project's SQL editor (Database → SQL Editor
-- → New query → paste all of this → Run).
--
-- Safe to re-run: every statement below uses IF NOT EXISTS, so if you ran an
-- earlier version of this file, running the whole thing again just adds the
-- new columns without touching your existing rows.
--
-- NOTE: submissions are now written ONLY by the /api/verify-submission
-- serverless function (service-role key, which bypasses RLS). Re-running this
-- file therefore REMOVES the old open "anon insert" policies — see below.
-- ===========================================================================

-- One row per heritage site. A site can have many submitted photos.
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- What kind of site this is. Nullable/free-ish so a not-yet-listed type
-- doesn't block a submission — the capture form offers a fixed set of common
-- categories plus "Other", but nothing stops you from setting more later.
alter table sites add column if not exists category text;

-- One row per submitted photo: the picture, the coordinate it was taken at,
-- the AI screening result, and its moderation status.
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  storage_path text not null,
  photo_url text not null,
  notes text,
  lat double precision not null,
  lng double precision not null,
  ai_label text,
  ai_confidence numeric,
  ai_flagged boolean not null default false,
  ai_source text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

-- Geolocation API accuracy radius, in meters, for the GPS fix — lets a
-- moderator judge how trustworthy a pin's position actually is.
alter table photos add column if not exists gps_accuracy_m double precision;

-- Actual pixel dimensions of the uploaded photo, read straight from the same
-- <img> the AI heuristic already inspects — turns "flagged as low-res" into
-- a checkable fact instead of just a label.
alter table photos add column if not exists width_px integer;
alter table photos add column if not exists height_px integer;

-- Optional credit for whoever documented the site.
alter table photos add column if not exists contributor_name text;

-- When a moderator's approve/reject decision was made (null while pending).
alter table photos add column if not exists reviewed_at timestamptz;

create index if not exists photos_site_id_idx on photos (site_id);
create index if not exists photos_status_idx on photos (status);

alter table sites enable row level security;
alter table photos enable row level security;

-- ---------------------------------------------------------------------------
-- Access policies.
--   * Anyone may READ sites/photos (the public map + moderation tab need it).
--   * Nobody using the public anon key may INSERT sites/photos or upload files
--     any more: that would let people skip the Gemini/GPS verification by
--     calling Supabase directly (the anon key is public in config.js). All
--     inserts now go through /api/verify-submission with the service-role key.
--   * "photos update" stays open ONLY so the prototype's Moderation tab keeps
--     working without a login. Before real use, replace it with authenticated
--     moderator accounts (e.g. `using (auth.role() = 'authenticated')`).
-- ---------------------------------------------------------------------------
drop policy if exists "sites anon select" on sites;
drop policy if exists "sites anon insert" on sites;
drop policy if exists "sites anon update" on sites;
create policy "sites anon select" on sites for select using (true);

drop policy if exists "photos anon select" on photos;
drop policy if exists "photos anon insert" on photos;
drop policy if exists "photos anon update" on photos;
create policy "photos anon select" on photos for select using (true);
create policy "photos anon update" on photos for update using (true);

-- ---------------------------------------------------------------------------
-- Reference verification dataset: known ASI-protected monuments, used to
-- sanity-check user submissions — both by showing a moderator a reference
-- photo (where one is on file), and by flagging whether the submitted GPS
-- coordinate is anywhere near a known site.
-- ---------------------------------------------------------------------------
create table if not exists reference_sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  state text,
  district text,
  category text,
  lat double precision not null,
  lng double precision not null,
  image_url text,
  image_attribution text,
  source text not null default 'ASI',
  created_at timestamptz not null default now()
);

alter table reference_sites add column if not exists district text;

create index if not exists reference_sites_lat_idx on reference_sites (lat);
create index if not exists reference_sites_lng_idx on reference_sites (lng);
-- Real monument registers legitimately reuse generic names ("Old Fort",
-- "Inscribed slab") across different districts, so uniqueness is on the
-- combination of name + coordinate, not name alone — that only catches true
-- duplicate rows (re-importing the same seed twice), not distinct sites that
-- happen to share a name.
drop index if exists reference_sites_name_key;
create unique index if not exists reference_sites_name_latlng_key on reference_sites (name, lat, lng);

alter table reference_sites enable row level security;

drop policy if exists "reference_sites anon select" on reference_sites;
create policy "reference_sites anon select" on reference_sites for select using (true);
-- deliberately no anon insert/update policy — this table is meant to be
-- populated by the project maintainers (via CSV import, see README), not
-- written to by app users.

-- Finds the closest catalogued reference site to a given coordinate, and how
-- far away it is in metres, using the haversine formula directly in SQL —
-- no PostGIS/earthdistance extension required.
-- Dropped first because CREATE OR REPLACE can't change a table-returning
-- function's output columns (e.g. when `district` was added below) — only
-- DROP + CREATE can. Safe to re-run any time.
drop function if exists nearest_reference_site(double precision, double precision);

create or replace function nearest_reference_site(p_lat double precision, p_lng double precision)
returns table (
  id uuid,
  name text,
  state text,
  district text,
  category text,
  image_url text,
  image_attribution text,
  distance_m double precision
)
language sql
stable
as $$
  select
    id, name, state, district, category, image_url, image_attribution,
    2 * 6371000 * asin(sqrt(
      power(sin(radians((lat - p_lat) / 2)), 2) +
      cos(radians(p_lat)) * cos(radians(lat)) *
      power(sin(radians((lng - p_lng) / 2)), 2)
    )) as distance_m
  from reference_sites
  order by distance_m asc
  limit 1;
$$;

grant execute on function nearest_reference_site(double precision, double precision) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed data: NOT included in this file. reference_sites is meant to hold
-- thousands of rows (see reference_sites_seed.csv), which is impractical as
-- inline SQL INSERT statements. Import it instead via:
-- Supabase dashboard -> Table Editor -> reference_sites -> Insert ->
-- Import data from CSV -> select reference_sites_seed.csv.
-- See README.md -> "Reference verification dataset" for exactly what's in
-- that file, where it came from, and its known limitations.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Verification pipeline additions (used by /api/verify-submission)
-- ---------------------------------------------------------------------------
-- Which register (ASI) entry a site / photo was verified against, how far the
-- contributor's GPS fix was from it, a SHA-256 of the image bytes (exact
-- duplicate detection), and the full verification record for moderators.
alter table sites  add column if not exists reference_site_id uuid references reference_sites(id) on delete set null;
alter table photos add column if not exists reference_site_id uuid references reference_sites(id) on delete set null;
alter table photos add column if not exists distance_to_reference_m double precision;
alter table photos add column if not exists image_sha256 text;
alter table photos add column if not exists verification jsonb;

create index if not exists photos_reference_site_idx on photos (reference_site_id);
create index if not exists photos_image_sha256_idx on photos (image_sha256);
create index if not exists sites_reference_site_idx on sites (reference_site_id);

-- Register entries within p_radius_m of a coordinate, nearest first. A cheap
-- lat/lng bounding box (uses the indexes above) narrows the rows before the
-- exact haversine distance is computed.
drop function if exists reference_sites_within(double precision, double precision, double precision, integer);
create or replace function reference_sites_within(
  p_lat double precision, p_lng double precision, p_radius_m double precision, p_limit integer default 10
)
returns table (
  id uuid, name text, state text, district text, category text,
  lat double precision, lng double precision, image_url text, distance_m double precision
)
language sql
stable
as $$
  select * from (
    select
      id, name, state, district, category, lat, lng, image_url,
      2 * 6371000 * asin(sqrt(
        power(sin(radians((lat - p_lat) / 2)), 2) +
        cos(radians(p_lat)) * cos(radians(lat)) *
        power(sin(radians((lng - p_lng) / 2)), 2)
      )) as distance_m
    from reference_sites
    where lat between p_lat - (p_radius_m / 111000.0) and p_lat + (p_radius_m / 111000.0)
      and lng between p_lng - (p_radius_m / (111000.0 * greatest(cos(radians(p_lat)), 0.01)))
                  and p_lng + (p_radius_m / (111000.0 * greatest(cos(radians(p_lat)), 0.01)))
  ) t
  where distance_m <= p_radius_m
  order by distance_m asc
  limit p_limit;
$$;
grant execute on function reference_sites_within(double precision, double precision, double precision, integer) to service_role;

-- Remove the old open upload policy on the photo bucket. The serverless
-- function uploads with the service-role key, which doesn't need a policy.
drop policy if exists "heritage-photos anon upload" on storage.objects;
