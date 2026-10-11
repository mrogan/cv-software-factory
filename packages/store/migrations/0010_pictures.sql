-- Pictures of a release while both its versions run: each page of the app on the stable version and on the canary,
-- compared pixel by pixel, once for each canary and the version it replaces. The probes worker takes them and keeps
-- the images in the artifact store; this is their index. The line reads it at Verify, for the pages a verification
-- compares with the version before, and to know that a screenshot it attaches to an event is in the artifact store,
-- which it cannot reach itself.
create table pictures (
  -- The canary's version and the stable version it was compared with, each as its `/version` said.
  canary   text not null,
  stable   text not null,
  path     text not null,
  -- The path's route, as the senses name it (`/products/:slug`).
  route    text not null,
  -- Screenshots, as an event's artifacts name them: the page on the stable version, and on the canary.
  before   jsonb not null,
  after    jsonb not null,
  -- The share of pixels that differ, and a picture of where; no picture when none do.
  changed  double precision not null check (changed >= 0 and changed <= 1),
  diff     jsonb,
  -- The page on the stable Service once the canary has been promoted, for a page with elements a sense boxed.
  rollout  jsonb,
  taken_at timestamptz not null default clock_timestamp(),
  primary key (canary, stable, path)
);

-- Where a sense's signal was seen: the page its screenshot was taken on, and the elements it boxed there. The pictures
-- box the same elements on the same page, so the ticket's own page can be seen on the canary and after the rollout as
-- it was at the signal.
create table looks (
  sense    text not null,
  "check"  text not null,
  route    text not null,
  path     text not null,
  elements jsonb not null,
  seen_at  timestamptz not null,
  primary key (sense, "check", route)
);

-- The probes worker writes pictures, and adds a page's rollout once; the probes and the crawler keep their looks up to
-- date. The line only reads.
grant select, insert, update (rollout) on pictures to factory_writer;
grant select, insert, update on looks to factory_writer;
