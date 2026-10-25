#!/usr/bin/env bash
# CI's copy of the third-party images the repository pins, in this repository's GHCR: Docker's official images, and
# Playwright's from Microsoft's registry.
#
# Hosted runners share their addresses, and Docker Hub limits anonymous pulls by address, so CI's pulls of the images
# the repository pins fail now and then; Microsoft's registry is now and then slow, a few minutes for Playwright's
# image. Every pin names its own registry, as `node:<tag>@<digest>` or `mcr.microsoft.com/playwright:<tag>@<digest>`,
# which the cluster pulls and Dependabot reads. CI pulls the same digest from this repository's GHCR instead, when it is
# there, and from its own registry when it is not yet. Only mirror.yml writes to GHCR, copying once a day: a handful of
# requests.
#
#   ci-images.sh resolve <ref>      the copy of <ref>, by digest, if it can be pulled with no credentials; else <ref>
#   ci-images.sh postgres           the same, for the Postgres the cluster runs: its one pin is its StatefulSet's
#   ci-images.sh contexts <name>…   for each, the build contexts that point each FROM its Dockerfile pins at the copy, as
#                                   the step output <name>, for build-push-action's build-contexts: apps/<name>/Dockerfile,
#                                   or for `browser`, apps/factory/Dockerfile.browser
#   ci-images.sh sync               copy into GHCR every pinned digest, each pinned tag's current one, and the newest tag
#                                   of each pin's line; skopeo must be logged in to ghcr.io (mirror.yml)
#
# A copy is byte for byte, by digest: Docker Hub's <name>@<digest> at ghcr.io/<repository>/mirror/docker/library/<name>,
# Microsoft's mcr.microsoft.com/<name>@<digest> at ghcr.io/<repository>/mirror/mcr/<name>. Its one tag,
# digest-<hex>, never moves, and nothing reads it.
set -uo pipefail

# Microsoft's registry, which the repository pins Playwright's image from, by its whole name.
MCR=mcr.microsoft.com/
# GHCR's names are lowercase.
MIRROR=ghcr.io/$(tr '[:upper:]' '[:lower:]' <<< "${GITHUB_REPOSITORY:-the-roganator/cv-software-factory}")/mirror/
# The copies made before the repository moved to the-roganator (ADR 0014), under its former owner, where GHCR keeps them:
# read when this repository's own GHCR has no copy yet, and never written.
FORMER=ghcr.io/mrogan/${MIRROR#ghcr.io/*/}
# A pin, as a Dockerfile's FROM or a manifest's image names it: a name with no registry (Docker Hub's official images)
# or Playwright's on Microsoft's registry, an optional tag, and a digest. The pin is its last word.
PIN='(^FROM|image:) +([a-z0-9._-]+|mcr\.microsoft\.com/playwright)(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}'

# The pins in grep's matches.
pins() { awk '{print $NF}'; }

# Where a pin's name comes from, as skopeo names it: Docker Hub's official images under docker.io/library/.
upstream_of() { if [[ "$1" == "$MCR"* ]]; then echo "docker://$1"; else echo "docker://docker.io/library/$1"; fi; }

# The copy of a pin, by digest.
mirror_of() {
  local name=${1%@*}
  name=${name%%:*}
  if [[ "$name" == "$MCR"* ]]; then echo "${MIRROR}mcr/${name#"$MCR"}@${1##*@}"; else echo "${MIRROR}docker/library/$name@${1##*@}"; fi
}

# Whether an image can be pulled with no credentials, as CI's jobs pull it.
pullable() { skopeo inspect --raw --no-creds "docker://$1" > /dev/null 2>&1; }

resolve() {
  local ref=$1 copy former
  copy=$(mirror_of "$ref")
  former=$FORMER${copy#"$MIRROR"}
  if pullable "$copy"; then
    echo "$copy"
  elif pullable "$former"; then
    echo "$former"
  else
    echo "::warning::$ref is not in GHCR yet, so it comes from its own registry (mirror.yml copies it daily)" >&2
    echo "$ref"
  fi
}

postgres() {
  local pin
  pin=$(grep -oE "$PIN" deploy/base/postgres/statefulset.yaml | pins)
  [ -n "$pin" ] || { echo "::error::No Postgres pin found" >&2 && return 1; }
  resolve "$pin"
}

contexts() {
  local app dockerfile ref copy
  for app in "$@"; do
    dockerfile=apps/$app/Dockerfile
    [ "$app" = browser ] && dockerfile=apps/factory/Dockerfile.browser
    {
      echo "$app<<EOF"
      for ref in $(grep -oE "$PIN" "$dockerfile" | pins | sort -u); do
        copy=$(resolve "$ref")
        [ "$copy" = "$ref" ] || echo "$ref=docker-image://$copy"
      done
      echo EOF
    } >> "$GITHUB_OUTPUT"
  done
}

# The newest tag on a pin's line: the same first number, as many numbers, and the same prefix and suffix
# (24.21.0-alpine3.24 → 24.x.y-alpine3.24, v1.64.1-noble → v1.x.y-noble), the tag Dependabot would move the pin to,
# outside a major version. Nothing for a tag that is not a version; fails when the tags cannot be listed.
newest() {
  local name=$1 tag=$2 prefix version suffix pattern tags
  version=${tag%%-*}
  prefix=${version%%[0-9]*}
  version=${version#"$prefix"}
  [[ "$prefix" =~ ^v?$ && "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 0
  suffix=${tag#"$prefix$version"}
  pattern="^$prefix${version%%.*}$(sed -E 's/[0-9]+/[0-9]+/g; s/\./\\./g' <<< "${version#"${version%%.*}"}")$(sed 's/\./\\./g' <<< "$suffix")\$"
  tags=$(skopeo list-tags --no-creds "$(upstream_of "$name")" | jq -r '.Tags[]') || return 1
  { grep -E "$pattern" <<< "$tags" || true; } | sort -V | tail -n 1
}

# The digest a tag names on its own registry now.
current() { skopeo inspect --raw --no-creds "$(upstream_of "$1")" | sha256sum | sed 's/^/sha256:/; s/ .*//'; }

sync() {
  local failed=() wanted=() pins ref name tag latest digest copy
  pins=$(git grep -hoE "$PIN" -- ':!*.md' | pins | sort -u)
  [ -n "$pins" ] || { echo "::error::No pin of a third-party image found" && return 1; }
  # What to copy, as name@digest: every pin, and the current digest of each pinned tag and of its line's newest tag.
  for ref in $pins; do
    name=${ref%@*}
    wanted+=("${name%%:*}@${ref##*@}")
    [[ "$name" == *:* ]] || continue
    tag=${name#*:}
    name=${name%%:*}
    latest=$(newest "$name" "$tag") || failed+=("$name: could not list its tags")
    for tag in "$tag" "$latest"; do
      [ -n "$tag" ] || continue
      if digest=$(current "$name:$tag"); then
        wanted+=("$name@$digest")
      else
        failed+=("$name:$tag: could not read its digest")
      fi
    done
  done
  # Docker's images first: Playwright's is two gigabytes, so a slow copy of it cannot hold the others up.
  for ref in $(printf '%s\n' "${wanted[@]}" | sort -u | grep -v "^$MCR"; printf '%s\n' "${wanted[@]}" | sort -u | grep "^$MCR"); do
    copy=$(mirror_of "$ref")
    if pullable "$copy"; then
      echo "$copy: copied already"
      continue
    fi
    echo "$copy: copying from $(upstream_of "$ref")"
    # Every platform, byte for byte, so the digest is the source's.
    if ! skopeo copy --all --preserve-digests --retry-times 3 \
      "$(upstream_of "$ref")" "docker://${copy%@*}:digest-${ref##*:}"; then
      failed+=("$copy: the copy failed")
    elif ! pullable "$copy"; then
      # A private package would send every build back to the image's own registry, with only a warning.
      failed+=("$copy: copied, but it cannot be pulled with no credentials: make ${copy%@*} public in its settings")
    fi
  done
  [ ${#failed[@]} -eq 0 ] && return 0
  printf '::error::%s\n' "${failed[@]}"
  return 1
}

case "${1:-}" in
  resolve) resolve "$2" ;;
  postgres) postgres ;;
  contexts) shift && contexts "$@" ;;
  sync) sync ;;
  *) echo "usage: $0 resolve <ref> | postgres | contexts <app>... | sync" >&2 && exit 2 ;;
esac
