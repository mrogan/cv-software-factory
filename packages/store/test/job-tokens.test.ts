import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endJobToken, issueJobToken, jobForToken } from '../src/job-tokens.ts';
import { type Database, freshDatabase } from './database.ts';

let database: Database;
let writer: Sql;

beforeAll(async () => {
  database = await freshDatabase('job_tokens');
  writer = database.writer;
});
afterAll(() => database?.end());

describe('job tokens', () => {
  it('are good for their job until it ends, and kept only as a hash', async () => {
    const job = { job: 'coder-1001-1', workItem: '1001', agent: 'coder' };
    const token = await issueJobToken(writer, job);
    expect(token).toMatch(/^sfj_[A-Za-z0-9_-]{43}$/);
    expect(await jobForToken(writer, token)).toEqual(job);
    const rows = await writer`select * from job_tokens`;
    expect(JSON.stringify(rows)).not.toContain(token.slice(4));

    await endJobToken(writer, job.job);
    await endJobToken(writer, job.job);
    expect(await jobForToken(writer, token)).toBeUndefined();
    expect(await jobForToken(writer, 'sfj_not-a-token')).toBeUndefined();
  });

  it('keep the trace of the step they were made for, and refuse one of another shape', async () => {
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const job = { job: 'coder-1003-1', workItem: '1003', agent: 'coder', traceparent };
    const token = await issueJobToken(writer, job);
    expect(await jobForToken(writer, token)).toEqual(job);
    // The writer may not change it, and the trigger refuses even the owner.
    await expect(writer`update job_tokens set traceparent = null where job = 'coder-1003-1'`).rejects.toThrow();
    await expect(database.owner`update job_tokens set traceparent = null where job = 'coder-1003-1'`).rejects.toThrow(
      /only be ended, once/,
    );
    const invalid = [
      'not a trace',
      `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`,
      `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`,
      `ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    ];
    for (const [i, bad] of invalid.entries()) {
      await expect(
        issueJobToken(writer, { job: `coder-1004-${i}`, workItem: '1004', agent: 'coder', traceparent: bad }),
      ).rejects.toThrow();
    }
  });

  it('can be ended and nothing else', async () => {
    const token = await issueJobToken(writer, { job: 'planner-1002-1', workItem: '1002', agent: 'planner' });
    await expect(writer`update job_tokens set agent = 'coder' where job = 'planner-1002-1'`).rejects.toThrow();
    await expect(writer`delete from job_tokens`).rejects.toThrow();
    await endJobToken(writer, 'planner-1002-1');
    await expect(writer`update job_tokens set ended_at = now() where job = 'planner-1002-1'`).rejects.toThrow(
      /only be ended, once/,
    );
    expect(await jobForToken(writer, token)).toBeUndefined();
  });
});

describe('job tokens in a store not yet migrated to keep their trace', () => {
  it('are made and read without it, as the console’s image may migrate the store after the factory’s deploys', async () => {
    const old = await freshDatabase('job_tokens_before_0021');
    try {
      await old.owner`alter table job_tokens drop column traceparent`;
      const job = { job: 'coder-1005-1', workItem: '1005', agent: 'coder' };
      const token = await issueJobToken(old.writer, {
        ...job,
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      });
      expect(await jobForToken(old.writer, token)).toEqual(job);
    } finally {
      await old.end();
    }
  });
});
