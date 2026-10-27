#!/usr/bin/env bash
# Install only the already reviewed CLI archive pin; never a floating setup action.
set -euo pipefail
[[ $# == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]]
task_cli=$(mktemp -d "${RUNNER_TEMP:-/tmp}/chat-inbox-cli.XXXXXXXX")
readarray -t pin < <(node --input-type=module -e 'import fs from "node:fs";const d=JSON.parse(fs.readFileSync("scripts/ci/toolchain.json")).database;if(d.cliVersion!=="2.117.0")throw Error("CLI pin drift");console.log(d.cliArchive);console.log(d.cliArchiveSha256)')
[[ ${pin[0]} == https://github.com/supabase/cli/releases/download/v2.117.0/supabase_linux_amd64.tar.gz && ${pin[1]} =~ ^[a-f0-9]{64}$ ]]
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "${pin[0]}" -o "$task_cli/cli.tar.gz"
echo "${pin[1]}  $task_cli/cli.tar.gz" | sha256sum --check --status
tar -xzf "$task_cli/cli.tar.gz" -C "$task_cli"
[[ $("$task_cli/supabase" --version | head -n1) == 2.117.0 ]]
echo "$task_cli" >> "$GITHUB_PATH"
