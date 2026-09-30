# The console image. Built from the repository root, so the workspace lockfile and the design system are in reach:
#
#     docker build --file apps/console/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# The image keeps the repository's layout, so the server finds its files where it does in development.

FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
WORKDIR /repo
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile --prod --filter @software-factory/console
COPY apps/console/src apps/console/src
COPY apps/console/public apps/console/public
COPY docs/design/system/tokens.css docs/design/system/
COPY docs/design/system/mark/icon.svg docs/design/system/mark/
# Readable by the unprivileged runtime user, and by nobody's writes.
RUN chmod -R a+rX,go-w /repo

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d
COPY --from=build /repo /repo
WORKDIR /repo/apps/console
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["--import", "./src/telemetry.ts", "src/server.ts"]
