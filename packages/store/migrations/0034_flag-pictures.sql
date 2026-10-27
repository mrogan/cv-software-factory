-- Verify's pictures of a feature flag's pages (milestone 7, task 17): the pages an improvement's spec names, taken by
-- the probes worker against the stable Service with the flag off, as the baseline, and again at Checks, with it on,
-- each compared with the page with it off. The images are in the artifact store, which the probes worker writes; this
-- is their index, as `pictures` is a release's. The line reads it to know that a screenshot it names on `flag.checked`
-- is in the artifact store, which it cannot reach itself. A row is kept while an event names its images, and one no
-- event came to name is forgotten after a day, with its images.
create table flag_pictures (
  flag     text not null,
  -- The stage the run checked the flag at: off, the baseline, or checks.
  stage    text not null check (stage in ('off', 'checks')),
  -- The flag set's revision the app reported, and its version, as `/version` said.
  revision text not null,
  version  text not null,
  path     text not null,
  -- The path's route, as the senses name it (`/products/:slug`).
  route    text not null,
  -- The screenshot, as an event's artifacts name it.
  shot     jsonb not null,
  -- At checks, the share of pixels that differ from the page with the flag off, and a picture of where; none without
  -- a page with the flag off to compare with, and no picture when no pixel differs.
  changed  double precision check (changed >= 0 and changed <= 1),
  diff     jsonb,
  taken_at timestamptz not null default clock_timestamp(),
  primary key (flag, stage, revision, version, path)
);

-- The line asks for a screenshot by its hash, whichever column holds it.
create index flag_pictures_shot on flag_pictures ((shot->>'hash'));
create index flag_pictures_diff on flag_pictures ((diff->>'hash'));

-- The probes worker takes them, and forgets those no event names; the line only reads.
grant select, insert (flag, stage, revision, version, path, route, shot, changed, diff), delete
  on flag_pictures to factory_probes;
grant select on flag_pictures to factory_line;
