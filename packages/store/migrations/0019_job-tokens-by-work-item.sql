-- A work item's job tokens, found without reading them all: the line numbers each step after the last number among
-- them (`Queue.startStep`), and the table only grows. A plain index, made in the migrations' one transaction: the
-- table is small, and nothing needs it to exist before the code that uses it, which works without it, only slower.
create index job_tokens_work_item on job_tokens (work_item);
