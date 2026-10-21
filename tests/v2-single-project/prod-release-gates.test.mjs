import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/backend-prod-v2-image-shadow-deploy.yml", import.meta.url), "utf8",
);
const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");

test("Prod image deploy workflow is manual-only and pinned to owner on main", () => {
  assert.match(workflow, /\bon:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.actor == 'vivek2310sharma'/);
  assert.match(workflow, /confirm_project_ref/);
  assert.match(workflow, /environment: FairSwapProd-moderation-diagnostics/);
  assert.match(workflow, /persist-credentials: false/);
});

test("Prod deploy is only one shadow image diagnostic with JWT gate and pinned CLI", () => {
  const matches = Array.from(workflow.matchAll(/\bfunctions deploy ([a-z0-9-]+)/g));
  assert.deepEqual(matches.map(x => x[1]), ["moderation-v2-image-shadow-probe"]);
  assert.match(workflow, /--project-ref kriuhwppxgxsyyrbjsau/);
  assert.match(workflow, /sha256sum -c --status/);
  assert.match(workflow, /supabase\.tar\.gz/);
  assert.match(workflow, /FAIRSWAP_PROD_SHADOW_DEPLOY_TOKEN/);
  assert.doesNotMatch(workflow, /^\s*(?:db push|db reset|migration up|functions deploy process-listing-moderation-v2)/m);
  const section = config.match(/\[functions\.moderation-v2-image-shadow-probe\]\s*\n([^\[]*)/);
  assert.ok(section);
  assert.match(section[1], /^\s*verify_jwt\s*=\s*true\s*$/m);
});

test("Prod workflow cannot silently activate V2 or reuse the scope-check secret", () => {
  assert.doesNotMatch(workflow, /FAIRSWAP_PROD_SUPABASE_ACCESS_TOKEN/);
  assert.doesNotMatch(workflow, /SET\s+moderation_v2_enabled|UPDATE\s+app_system_settings/i);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|SERVICE_ROLE_KEY/);
});
