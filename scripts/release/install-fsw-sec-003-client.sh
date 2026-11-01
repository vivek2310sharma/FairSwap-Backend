#!/usr/bin/env bash
# PGDG supports noble; Ubuntu's default repository does not supply PG17.
# https://www.postgresql.org/download/linux/ubuntu/
set -euo pipefail
[[ $# == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]]
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $VERSION_CODENAME == noble ]]
task_key=$(mktemp)
trap 'rm -f "$task_key"' EXIT
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$task_key"
[[ $(gpg --batch --show-keys --with-colons "$task_key" | awk -F: '$1 == "fpr" {print $10; exit}') == B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]]
sudo install -m 0644 "$task_key" /usr/share/keyrings/fsw-pgdg.asc
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/fsw-pgdg.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' | sudo tee /etc/apt/sources.list.d/fsw-pgdg.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends postgresql-client-17
[[ $(/usr/lib/postgresql/17/bin/psql --version) == 'psql (PostgreSQL) 17.'* ]]
echo '/usr/lib/postgresql/17/bin' >> "$GITHUB_PATH"
