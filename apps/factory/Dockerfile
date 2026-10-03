# The factory image: the gateway, triage, the intake and the log watcher run from it, each as a command of the one
# CLI (`factory gateway`, `factory triage`, ...). Built from the repository root, so the workspace lockfile, the shared
# packages and the policy files are in reach:
#
#     docker build --file apps/factory/Dockerfile .
#
# It is TypeScript that Node runs as it is, with its production dependencies only, in the repository's own layout so
# that `policy/` is found where the code imports it. The probes and the crawler need a browser and run from
# Dockerfile.browser instead. The migrations are not here: the console's image applies them.

FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /repo
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/factory/package.json apps/factory/
COPY packages/events/package.json packages/events/
COPY packages/store/package.json packages/store/
COPY packages/triage/package.json packages/triage/

FROM base AS server
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/factory...
COPY apps/factory/src apps/factory/src
COPY packages/events/src packages/events/src
COPY packages/store/src packages/store/src
COPY packages/triage/src packages/triage/src
COPY policy policy
# Readable by the unprivileged runtime user, and by nobody's writes.
RUN chmod -R a+rX,go-w /repo

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d
COPY --from=server /repo /repo
WORKDIR /repo/apps/factory
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# A Deployment names the command: `--import ./src/telemetry.ts src/cli.ts gateway`. With none, the usage is printed.
CMD ["src/cli.ts"]
