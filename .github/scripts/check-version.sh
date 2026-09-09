#!/bin/sh
# The version lives in three files that have to agree, and on a tag it has to agree with the tag
# too. Nothing enforced this, so the three could drift apart in a pull request nobody read closely
# and the About panel would name a version the packages do not carry. See release-tasks.md R2.
set -eu

# The repository, or wherever the caller says: the override is what lets this be exercised from
# outside the tree it checks.
cd "${SUBLORE_ROOT:-$(dirname "$0")/../..}"

read_json() {
  # The version is the first "version" key at the top level of these two files, and both are
  # written by hand rather than generated, so a line-oriented read is honest here.
  sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1" | head -n 1
}

package_json=$(read_json package.json)
tauri_conf=$(read_json src-tauri/tauri.conf.json)
cargo_toml=$(sed -n 's/^version = "\([^"]*\)".*/\1/p' src-tauri/Cargo.toml | head -n 1)

fail=0
for pair in "package.json:$package_json" "src-tauri/tauri.conf.json:$tauri_conf" "src-tauri/Cargo.toml:$cargo_toml"; do
  file=${pair%%:*}
  found=${pair#*:}
  if [ -z "$found" ]; then
    echo "check-version: no version found in $file" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1

if [ "$package_json" != "$tauri_conf" ] || [ "$package_json" != "$cargo_toml" ]; then
  echo "check-version: the three files disagree" >&2
  echo "  package.json            $package_json" >&2
  echo "  src-tauri/tauri.conf.json $tauri_conf" >&2
  echo "  src-tauri/Cargo.toml    $cargo_toml" >&2
  exit 1
fi

# On a tag, the name is the claim a user reads on the release page, so it has to be the version the
# packages were built from. Off a tag there is nothing to compare against and this half is skipped.
case "${GITHUB_REF:-}" in
  refs/tags/v*)
    tag=${GITHUB_REF#refs/tags/v}
    if [ "$tag" != "$package_json" ]; then
      echo "check-version: the tag says $tag and the tree says $package_json" >&2
      exit 1
    fi
    echo "check-version: $package_json, and the tag agrees"
    ;;
  *)
    echo "check-version: $package_json in all three files"
    ;;
esac
