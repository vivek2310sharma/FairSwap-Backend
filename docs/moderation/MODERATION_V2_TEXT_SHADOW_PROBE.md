# FairSwap V2: Production text-only shadow probe

**Status:** Read-only manual operator tool, not the final V2 worker. No new project or schema changes.

Endpoint: POST /functions/v1/moderation-v2-text-shadow-probe in existing FairSwapProd.

## Capabilities

The function reads **one** authoritative listing (ID supplied as a UUID), validates its current status/revision, checks title and description via OpenAI's **free** pinned \`omni-moderation-2024-09-26\` Moderation API, evaluates English/Hindi/Hinglish fraud signals locally, then reads the listing again to detect stale input. It returns only flags/retry status, never text or seller information.

It is **text-only**: media/image review is NOT performed. A \`text_no_flags\` outcome is NOT an approval. No automatic V2 queue claim, sealer, Storage writes, SQL changes, finalization or publication happens.

No autonomous polling, scheduled task, paid GPT or Responses calls.

## Security

- Production target pinned to existing project \`kriuhwppxgxsyyrbjsau\`.
- Supabase Edge JWT gate **enabled** plus exact Bearer comparison against Supabase-provided \`SUPABASE_SERVICE_ROLE_KEY\`.
- Only trusted backend operators may invoke this endpoint; NEVER expose the service-role key to Web, Admin browser, Android, iOS or shared testing links.
- JSON accepts **only** \`{ "listingId": "<UUID>" }\`, max 512 request bytes; authentication happens before reading request body, database or OpenAI.
- The endpoint returns \`private, no-store\`, no CORS allowlist and no user text, provider raw scores, prompts, API keys or seller IDs.
- If \`OPENAI_API_KEY\` is missing, endpoint is inert (\`503 OPENAI_NOT_CONFIGURED\`).
- DB/protocol/provider failure and listing revision/source change produce \`retry\` or fail-closed errors.
- Only the real DB read-only query to \`public.listings\` is permitted. Any change of status, revision, text or updated_at during moderation invalidates the result.

## Production operator steps

1. CI must pass exactly on this feature branch; merge to Backend main.
2. Deploy only the **new** function \`moderation-v2-text-shadow-probe\` to existing FairSwapProd. Do not redeploy or modify the V1 worker.
3. Set \`OPENAI_API_KEY\` in FairSwapProd Edge Function Secrets using the dashboard, if absent. NEVER paste it into GitHub, tickets, mobile code, chats or logs.
4. Invoke POST **server-to-server only**, with a valid service-role JWT in the Authorization header and JSON listingId from an authorized test listing. Do not use the public Supabase anon key.
5. Verify the result carries \`SHADOW_TEXT_ONLY_NEVER_PUBLISH\`, has \`imageModeration: NOT_PERFORMED\`, and remains independent from listing status. Confirm no V2 requests or approvals have been generated.
6. Keep \`moderation_v2_enabled=false\`, \`moderation_v2_mode=disabled\` and V1 moderation enabled.
7. Before any automated shadow scheduling or enforce launch, finish trusted five-image registration, safeguarded serving/retirement, V2 worker and India DPDP/privacy review. Because the storage is in the same project, service_role still bypasses RLS; do not claim physical immutability.

## Test

\`node --experimental-strip-types --test tests/v2-single-project/*.test.mjs\`

The independent Backend CI already requires the full V2 test glob. New tests cover invalid requests, stale listing revision/content, scam signals, failed provider calls, missing key, wrong project, Bearer misuse, changed images not reviewed, and no text leakage.

This probe does **not** grant moderation-policy approval or open a new provider billing category. OpenAI Moderation remains free, although standard Supabase resource limits and network usage still apply.


## Synthetic OpenAI connectivity check (no customer data)

When an operator has just configured `OPENAI_API_KEY` in **FairSwapProd → Edge Functions → Secrets**, first verify the key against OpenAI without selecting a real listing or image:

```sh
node scripts/moderation/v2-shadow-invoke.mjs check
```

Run this only from the **trusted Backend operator terminal** that already has the legacy FairSwapProd `SUPABASE_SERVICE_ROLE_KEY` JWT in its protected process environment. Do not paste that JWT or the OpenAI API key into the command line, CI logs, Antigravity chat, GitHub, mobile applications, or support channels. The command has no listing or media argument and uses the pinned FairSwapProd endpoint; do not change the URL.

The live Supabase Edge Function verifies **JWT + service-role authorization** before parsing the strict `{"probe":"synthetic_connectivity"}` request. It sends only this predetermined harmless sentence to the **free** OpenAI Moderation API:

> A used bicycle is available for inspection in Pune. No advance payment required.

On success the result is `connected: true`, `authority: SYNTHETIC_CONNECTIVITY_ONLY`, and model `omni-moderation-2024-09-26`. It proves this particular function invoked the provider successfully with the configured key. It does **not** verify a listing, photo, scam or publication decision.

On failure the command prints only a safe code, for example:
- `SERVICE_ROLE_JWT_NOT_CONFIGURED`: operator-side legacy service-role JWT missing; the Supabase browser/dashboard key is not the same as the OpenAI API key.
- `OPENAI_NOT_CONFIGURED`: `OPENAI_API_KEY` was not available to the Edge function.
- `PROVIDER_CHECK_FAILED` with `PROVIDER_AUTH`: OpenAI rejected the key or moderation permission; inspect **only** permissions/project, never print the token.
- `PROVIDER_CHECK_FAILED` with `PROVIDER_LIMIT`: provider rate or quota limit.
- `PROVIDER_CHECK_FAILED` with `PROVIDER_SCHEMA`: model or provider contract changed.
- `SHADOW_UNAVAILABLE` or `NETWORK_OR_TIMEOUT`: investigate gateway/region/network without logging secrets.

For Production user-data checks, use `text <test-listing-uuid>` or the separate image shadow probe only on an **operator-authorized** test listing. A synthetic success cannot enable V2 automatically, and the endpoint performs **zero** DB reads, Storage operations or finalization calls.

**Required states remain:** V1 ON, V2 OFF, no V2 queue worker active; no new Supabase project or paid OpenAI models.
