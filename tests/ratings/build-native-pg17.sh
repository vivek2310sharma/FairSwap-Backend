#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
build_root="$repo/artifacts/ratings/pg17-source"
if [[ ${1:-} == --prebuilt && $# -le 2 ]]; then
  build_root=${2:-$build_root}
  [[ $build_root == /* && $(uname -s)-$(uname -m) == Linux-x86_64 ]] || {
    echo "Prebuilt PostgreSQL requires Ubuntu 24.04 amd64 and an absolute install root" >&2
    exit 2
  }
  . /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || {
    echo "Prebuilt PostgreSQL requires Ubuntu 24.04 amd64" >&2
    exit 2
  }
elif (( $# != 0 )); then
  echo "Usage: $0 [--prebuilt [absolute-install-root]]" >&2
  exit 2
fi
[[ ! -e "$build_root" ]] || { echo 'Refusing nonfresh build directory' >&2; exit 2; }
mkdir -p "$build_root"
if [[ ${1:-} == --prebuilt ]]; then
  # Extract the PGDG packages without running their service or cluster setup scripts.
  packages=$(node --input-type=module -e '
    import fs from "node:fs";
    const {version, nobleAmd64} = JSON.parse(fs.readFileSync("tests/ratings/pg17-source.json"));
    for (const [name, sha256] of Object.entries(nobleAmd64))
      console.log(name + "_" + version + "-1.pgdg24.04+1_amd64.deb " + sha256);
  ')
  archive=https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/postgresql-17
  while read -r package sha256; do
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
      "$archive/$package" -o "$build_root/$package"
    printf '%s  %s\n' "$sha256" "$build_root/$package" | sha256sum --check --strict
    dpkg-deb --extract "$build_root/$package" "$build_root/install"
  done <<< "$packages"

  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    patchelf libicu74 libldap2 libllvm19 liblz4-1 libpam0g libreadline8t64 libssl3t64 libxml2 libxslt1.1 libzstd1
  pg_dir="$build_root/install/usr/lib/postgresql/17"
  # The fixture runners clear their environment. Resolve pinned libpq from the private tree.
  for elf in "$pg_dir/bin/"* "$pg_dir/lib/"*.so; do
    needed=$(patchelf --print-needed "$elf")
    if grep -Fxq libpq.so.5 <<< "$needed"; then
      patchelf --set-rpath '$ORIGIN/../../../x86_64-linux-gnu' "$elf"
    fi
  done
  ln -s usr/lib/postgresql/17/bin "$build_root/install/bin"
  "$build_root/install/bin/postgres" --version
  exit 0
fi
readarray -t pin < <(node --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync("tests/ratings/pg17-source.json"));console.log(p.version);console.log(p.url);console.log(p.sha256);for(const x of p.configure)console.log(x)')
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "${pin[1]}" -o "$build_root/source.tar.bz2"
printf '%s  %s\n' "${pin[2]}" "$build_root/source.tar.bz2" | sha256sum --check --strict
tar -xjf "$build_root/source.tar.bz2" -C "$build_root"
cd "$build_root/postgresql-${pin[0]}"
./configure --prefix="$build_root/install" "${pin[@]:3}"
make -j2
make install
"$build_root/install/bin/postgres" --version
