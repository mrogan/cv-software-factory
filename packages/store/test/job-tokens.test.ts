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
