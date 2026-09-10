#!/bin/sh
# Turn a tag into a draft release with the Linux packages on it.
#
# Until this existed a `v*` tag built packages for an hour and published nothing: they expired as CI
# artifacts and nobody outside the project could reach them. See release-tasks.md R1.
#
# Draft on purpose. `owner-run-v1.md` is a hand run against the very files a user would download, and
# it has to happen before anyone can download them; publishing the draft is a button afterwards.
#
# Usage: draft-release.sh <tag> <packages-dir>
# With SUBLORE_RELEASE_DRY_RUN set, it says what it would do and creates nothing.
set -eu

tag=${1:?the tag to release, for example v1.0.0}
packages=${2:?the directory holding the packages to attach}

if [ ! -d "$packages" ]; then
  echo "draft-release: $packages is not a directory" >&2
  exit 1
fi

# A release with nothing on it is worse than no release: it looks like a download that failed. And
# a release missing one of the three is the same thing for a third of the people who come for it, so
# each kind is required by name rather than counted together. `sh` leaves a glob that matches nothing
# alone, so passing the three patterns straight to `gh` handed it paths that do not exist and failed
# on the asset instead of on the truth, which is that a package is missing. See R4.
assets=""
missing=""
for kind in deb rpm AppImage; do
  found=$(find "$packages" -type f -name "*.$kind" | sort)
  if [ -z "$found" ]; then
    missing="$missing $kind"
    continue
  fi
  assets="$assets$found
"
done
if [ -n "$missing" ]; then
  echo "draft-release: no$missing package under $packages" >&2
  echo "  A release is the three Linux packages. Publishing without one is a download that is" >&2
  echo "  missing for whoever came for that kind." >&2
  exit 1
fi

# The notes are this version's own section of the changelog, from its heading to the next one. A
# changelog that does not mention this version is a release nobody wrote notes for, and that is a
# failure rather than something to paper over with a generated list of commits.
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
awk -v want="## $tag" '
  $0 == want { taking = 1; next }
  taking && /^## / { exit }
  taking { print }
' CHANGELOG.md > "$notes"

if [ ! -s "$notes" ]; then
  echo "draft-release: CHANGELOG.md has no \"## $tag\" section to take notes from" >&2
  exit 1
fi

# Said once on the page itself, for the same reason it is said in the README: the behavioural suite
# runs on Linux, so Linux is what this release is.
{
  echo
  echo "Sublore $tag runs on Linux. Nothing here has been run on any other system."
} >> "$notes"

if [ -n "${SUBLORE_RELEASE_DRY_RUN:-}" ]; then
  echo "draft-release: would create draft $tag with these packages:"
  printf '%s' "$assets" | sed 's/^/  /'
  echo "draft-release: and these notes:"
  sed 's/^/  /' "$notes"
  exit 0
fi

# The files themselves, never the patterns: what reaches `gh` is what `find` found. Built as
# positional arguments rather than piped, so a path with a space in it stays one path.
set -- --draft --title "Sublore $tag" --notes-file "$notes"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  set -- "$@" "$file"
done <<ASSETS
$assets
ASSETS

gh release create "$tag" "$@"
