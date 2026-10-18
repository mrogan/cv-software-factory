# The console image. Built from the repository root, so the workspace lockfile, the shared packages and the
# design system are in reach:
#
#     docker build --file apps/console/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# The browser code is built in one stage and the server's production dependencies installed in another; the
# runtime image takes the output of both, and keeps the repository's layout, so the server finds its files
# where it does in development. The migration Job runs this image too.

FROM node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS base
WORKDIR /repo
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/
COPY packages/events/package.json packages/events/
COPY packages/store/package.json packages/store/

# The browser code, built by Vite into apps/console/dist.
FROM base AS web
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @software-factory/console...
# Vite reads the compiler options web/tsconfig.json extends.
COPY tsconfig.base.json ./
COPY apps/console/vite.config.ts apps/console/
COPY apps/console/web apps/console/web
COPY packages/events/src packages/events/src
COPY docs/design/system/tokens.css docs/design/system/station.ts docs/design/system/
COPY docs/design/system/mark/icon.svg docs/design/system/mark/
ARG GIT_COMMIT=unknown
RUN GIT_COMMIT=$GIT_COMMIT pnpm --filter @software-factory/console build

# The server: TypeScript that Node runs as it is, and its production dependencies only.
FROM base AS server
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/console...
COPY apps/console/src apps/console/src
COPY packages/events/src packages/events/src
COPY packages/store/src packages/store/src
COPY packages/store/migrations packages/store/migrations
COPY --from=web /repo/apps/console/dist apps/console/dist
# Readable by the unprivileged runtime user, and by nobody's writes.
RUN chmod -R a+rX,go-w /repo

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:59c479c9b8c123e66047315c968aa2d35e31ae5149c856e4110a79c8b3563f0b
COPY --from=server /repo /repo
WORKDIR /repo/apps/console
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["--import", "./src/telemetry.ts", "src/server.ts"]
