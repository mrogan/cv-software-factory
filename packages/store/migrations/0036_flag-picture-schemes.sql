-- Verify pictures each of a flag's pages in both colour schemes, light and dark, as the browser says it prefers
-- (`prefers-color-scheme`), so a change that answers to either shows. Each picture names its scheme; one taken before,
-- in the browser's default, was light.
alter table flag_pictures
  add column scheme text not null default 'light' check (scheme in ('light', 'dark'));
alter table flag_pictures drop constraint flag_pictures_pkey;
alter table flag_pictures add primary key (flag, stage, revision, version, path, scheme);

grant insert (scheme) on flag_pictures to factory_probes;
