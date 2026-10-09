# The factory-runner image: what a runner's two pods run (`runner prepare`, `runner agent`). Built from the repository
# root, so the workspace lockfile is in reach:
#
#     docker build --file apps/runner/Dockerfile .
#
# It holds Node at the version the app pins, git, pnpm through corepack, and the Agent SDK. The app's own
# dependencies are not here: the prepare pod installs them onto the job's volume, from the app's lockfile.

FROM public.ecr.aws/docker/library/node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS node
# git, to check out the app and write the agent's patch. The Debian packages are the image's release's.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
# pnpm at the version the repository pins, which is the app's too, held in the image, read-only: the runner's pods
# have no way to change it, and the agent pod, with no network, has no need to fetch it.
ENV COREPACK_HOME=/opt/corepack
COPY package.json /tmp/pin/
RUN cd /tmp/pin && corepack install && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version \
  && rm -rf /tmp/pin && chmod -R a+rX,go-w /opt/corepack

FROM node AS runner
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/runner/package.json apps/runner/
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/runner...
COPY apps/runner/src apps/runner/src
# The skills a step can name, as a plugin the agent step loads (`plugin/README.md`).
COPY apps/runner/plugin apps/runner/plugin
# Readable by the unprivileged runtime user, and by nobody's writes.
RUN chmod -R a+rX,go-w /repo

FROM node
COPY --from=runner /repo /repo
USER 65532:65532
# The job's volume is /work: the checkout, its dependencies and the agent's session.
ENV NODE_ENV=production WORK=/work HOME=/work/home
WORKDIR /work
ENTRYPOINT ["node", "/repo/apps/runner/src/cli.ts"]
