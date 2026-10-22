#!/usr/bin/env bash
# The images of one group, as the cluster pins them (build.yml's push jobs): for each, an index of its two platforms'
# builds, tagged with the commit, from the digests its builds left in digests/<image>-<arch>.
#
#   image-index.sh <image>…
#
# Each image's digest goes to $GITHUB_OUTPUT, named after the image, and only once every image of the group has its
# index: a group is signed whole or not at all. Exits 1 if any could not be made.
set -uo pipefail

# $1: an image. Makes its index from its two builds, tags it with the commit, and prints its digest.
index() {
  local ref="ghcr.io/$GITHUB_REPOSITORY/$1" builds=() arch digest
  for arch in amd64 arm64; do
    digest=$(cat "digests/$1-$arch" 2> /dev/null)
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::$1 ($arch) has no digest: $digest" >&2; return 1; }
    builds+=("$ref@$digest")
  done
  docker buildx imagetools create --tag "$ref:$GITHUB_SHA" "${builds[@]}" >&2 || return 1
  docker buildx imagetools inspect "$ref:$GITHUB_SHA" --format '{{ json .Manifest }}' | jq -r .digest
}

made=()
for image in "$@"; do
  digest=$(index "$image") && [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
  echo "ghcr.io/$GITHUB_REPOSITORY/$image@$digest"
  made+=("$image=$digest")
done
printf '%s\n' "${made[@]}" >> "$GITHUB_OUTPUT"
