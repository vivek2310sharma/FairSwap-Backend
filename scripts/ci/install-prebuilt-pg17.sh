#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 && ${1:-} == /* ]] || { echo "Usage: $0 <absolute-install-root>" >&2; exit 2; }
[[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || {
  echo 'Prebuilt PostgreSQL requires Ubuntu 24.04 amd64' >&2
  exit 2
}
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || {
  echo 'Prebuilt PostgreSQL requires Ubuntu 24.04 amd64' >&2
  exit 2
}

build_root=$1
checksums="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/pg17-prebuilt.sha256"
[[ ! -e "$build_root" ]] || { echo 'Refusing nonfresh build directory' >&2; exit 2; }
mkdir -p "$build_root"
cd "$build_root"

archive=https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/postgresql-17
while read -r _ package; do
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
    "$archive/$package" -o "$package"
done < "$checksums"
sha256sum --check --strict "$checksums"
# Extract without running the packages' service or cluster setup scripts.
while read -r _ package; do
  dpkg-deb --extract "$package" "$build_root/install"
done < "$checksums"

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
