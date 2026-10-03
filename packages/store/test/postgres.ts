/**
 * A real Postgres for the store's tests: TEST_DATABASE_URL if it is set (CI sets it to a service container), or
 * else a throwaway container of the same image the cluster runs, removed when the tests finish.
 */
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

// The image deploy/base/postgres/statefulset.yaml runs.
const IMAGE = 'postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const given = process.env.TEST_DATABASE_URL;
  if (given) {
    project.provide('databaseUrl', given);
    return;
  }
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  try {
    docker('info', '--format', '{{.ServerVersion}}');
  } catch {
    throw new Error('The store tests need Postgres: set TEST_DATABASE_URL, or start Docker so they can run their own.');
  }
  const name = `software-factory-test-${process.pid}`;
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--env',
    'POSTGRES_USER=factory',
    '--env',
    'POSTGRES_PASSWORD=test',
    '--publish',
    '127.0.0.1::5432',
    IMAGE,
  );
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  // pg_isready answers before the server takes connections from outside; a query proves it does.
  for (let tries = 0; ; tries++) {
    try {
      docker('exec', name, 'psql', '-U', 'factory', '-h', '127.0.0.1', '-c', 'select 1');
      break;
    } catch (error) {
      if (tries > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  project.provide('databaseUrl', `postgres://factory:test@127.0.0.1:${port}/postgres`);
  return () => {
    docker('rm', '--force', name);
  };
}
