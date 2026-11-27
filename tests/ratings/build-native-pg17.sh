#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
build_root="$repo/artifacts/ratings/pg17-source"
[[ ! -e "$build_root" ]] || { echo 'Refusing nonfresh build directory' >&2; exit 2; }
mkdir -p "$build_root"
readarray -t pin < <(node --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync("tests/ratings/pg17-source.json"));console.log(p.version);console.log(p.url);console.log(p.sha256);for(const x of p.configure)console.log(x)')
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "${pin[1]}" -o "$build_root/source.tar.bz2"
printf '%s  %s\n' "${pin[2]}" "$build_root/source.tar.bz2" | sha256sum --check --strict
tar -xjf "$build_root/source.tar.bz2" -C "$build_root"
cd "$build_root/postgresql-${pin[0]}"
./configure --prefix="$build_root/install" "${pin[@]:3}"
make -j2
make install
"$build_root/install/bin/postgres" --version
