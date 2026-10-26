# Additive verification proposal for ChatGPT integration

No workflow, existing test allowlist/count, root package manifest or gate is changed.
Keep all toolchain, baseline, integrity, native database, profile/security checks and
`backend-ci-success` requirements. This suite is separate from the five-file/93-test
legacy Vitest contract and must not replace it or relax its exact-result verifier.

The requested base has no PGlite dependency. A self-contained test-only package is
therefore pinned under `tests/chat-v2-inbox-only`, with its own integrity lockfile.
It does not depend on unmerged Posting/Ratings/PR58 root dependency changes.

After installing root dependencies using the existing frozen command, ChatGPT can
add the following verification to the existing required CI lane, without secrets:

```sh
corepack pnpm --dir tests/chat-v2-inbox-only install --frozen-lockfile --ignore-scripts --engine-strict
node scripts/ci/test-chat-v2-inbox-only.mjs
node --test tests/chat-v2-inbox-only/renderer.test.mjs
```

No network is permitted during the SQL tests. The dependency-install phase fetches
only the integrity-pinned PGlite package; the runner accepts no connection, project,
host or environment arguments. Native PG execution and hosted release acceptance
remain separate requirements; PGlite is not a replacement for existing native gates.
The release renderer can be syntax-checked with `node --check` and is exercised for
both environments by this same isolated test command.
