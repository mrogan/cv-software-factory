#!/usr/bin/env bash
# CI's copy of Docker's official images, in this repository's GHCR.
#
# Hosted runners share their addresses, and both Docker Hub and Amazon's copy (public.ecr.aws) limit anonymous pulls
# by address, so CI's pulls of the images the repository pins fail now and then. Every pin names Amazon's copy, as the
# cluster pulls it and Dependabot reads it. CI pulls the same digest from this repository's GHCR instead, when it is
# there, and from Amazon's copy when it is not yet. Only mirror.yml writes to GHCR.
#
#   ci-images.sh resolve <ref>           the copy of <ref>, by digest, if it can be pulled with no credentials; else <ref>
#   ci-images.sh contexts <Dockerfile>…  build contexts that point each FROM it pins at the copy, for build-push-action
#   ci-images.sh sync                    copy into GHCR every pinned digest, each pinned tag's current one, and the newest
#                                        tag of each pin's line; skopeo must be logged in to ghcr.io (mirror.yml)
#
# A copy is public.ecr.aws/docker/library/<name>@<digest> at ghcr.io/<repository>/mirror/docker/library/<name>@<digest>,
# byte for byte. Its one tag, digest-<hex>, never moves, and nothing reads it.
set -uo pipefail

UPSTREAM=public.ecr.aws/docker/library/
MIRROR=ghcr.io/${GITHUB_REPOSITORY:-mrogan/cv-software-factory}/mirror/docker/library/
# A pinned reference: a name, an optional tag, and a digest.
PIN='public\.ecr\.aws/docker/library/[a-z0-9._-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}'

# The copy of an upstream reference, by digest.
mirror_of() {
  local name=${1%@*}
  name=${name#"$UPSTREAM"}
  echo "$MIRROR${name%%:*}@${1##*@}"
}

# Whether an image can be pulled with no credentials, as CI's jobs pull it.
pullable() { skopeo inspect --raw --no-creds "docker://$1" > /dev/null 2>&1; }

resolve() {
  local ref=$1 copy
  copy=$(mirror_of "$ref")
  if pullable "$copy"; then
    echo "$copy"
  else
    echo "::warning::$ref is not in GHCR yet, so it comes from Amazon's copy (mirror.yml copies it daily)" >&2
    echo "$ref"
  fi
}

contexts() {
  local ref copy
  for ref in $(grep -hoE "^FROM $PIN" "$@" | cut -d' ' -f2 | sort -u); do
    copy=$(resolve "$ref")
    [ "$copy" = "$ref" ] || echo "$ref=docker-image://$copy"
  done
}

# The newest tag on a pin's line: the same first number, as many numbers, and the same suffix (24.21.0-alpine3.24 →
# 24.x.y-alpine3.24), the tag Dependabot would move the pin to, outside a major version.
newest() {
  local name=$1 tag=$2 version suffix pattern
  version=${tag%%-*}
  [[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 0
  suffix=${tag#"$version"}
  pattern="^${version%%.*}$(sed -E 's/[0-9]+/[0-9]+/g; s/\./\\./g' <<< "${version#"${version%%.*}"}")$(sed 's/\./\\./g' <<< "$suffix")\$"
  skopeo list-tags --no-creds "docker://$UPSTREAM$name" | jq -r '.Tags[]' | grep -E "$pattern" | sort -V | tail -n 1
}

# The digest a tag names upstream now.
current() { skopeo inspect --raw --no-creds "docker://$UPSTREAM$1" | sha256sum | sed 's/^/sha256:/; s/ .*//'; }

sync() {
  local failed=() wanted=() pins ref name tag digest copy
  pins=$(git grep -hoE "$PIN" | sort -u)
  [ -n "$pins" ] || { echo "::error::No pin of $UPSTREAM found" && return 1; }
  # What to copy, as name@digest: every pin, and the current digest of each pinned tag and of its line's newest tag.
  for ref in $pins; do
    name=${ref#"$UPSTREAM"}
    name=${name%@*}
    wanted+=("${name%%:*}@${ref##*@}")
    [[ "$name" == *:* ]] || continue
    tag=${name#*:}
    name=${name%%:*}
    for tag in "$tag" "$(newest "$name" "$tag")"; do
      [ -n "$tag" ] || continue
      if digest=$(current "$name:$tag"); then
        wanted+=("$name@$digest")
      else
        failed+=("$name:$tag: could not read its digest upstream")
      fi
    done
  done
  for ref in $(printf '%s\n' "${wanted[@]}" | sort -u); do
    copy=$MIRROR$ref
    if pullable "$copy"; then
      echo "$copy: copied already"
      continue
    fi
    echo "$copy: copying from $UPSTREAM$ref"
    # Every platform, byte for byte, so the digest is the source's.
    if ! skopeo copy --all --preserve-digests --retry-times 3 \
      "docker://$UPSTREAM$ref" "docker://${copy%@*}:digest-${ref##*:}"; then
      failed+=("$copy: the copy failed")
    elif ! pullable "$copy"; then
      # A private package would send every build back to Amazon's copy, with only a warning.
      failed+=("$copy: copied, but it cannot be pulled with no credentials: make ${copy%@*} public in its settings")
    fi
  done
  [ ${#failed[@]} -eq 0 ] && return 0
  printf '::error::%s\n' "${failed[@]}"
  return 1
}

case "${1:-}" in
  resolve) resolve "$2" ;;
  contexts) shift && contexts "$@" ;;
  sync) sync ;;
  *) echo "usage: $0 resolve <ref> | contexts <Dockerfile>... | sync" >&2 && exit 2 ;;
esac
