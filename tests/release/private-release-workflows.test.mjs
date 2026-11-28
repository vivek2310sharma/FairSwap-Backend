import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';

const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
// Retired workflows are preserved outside the active directory so GitHub cannot run them.
const archived = name => readFileSync(new URL(`../../docs/operations/archived-workflows/${name}.yml`, import.meta.url), 'utf8');

test('at most five workflows are active and every retired workflow is archived, not active', () => {
  const active = readdirSync(new URL('../../.github/workflows/', import.meta.url)).sort();
  assert.deepEqual(active, ['backend-ci.yml', 'backend-scoped-token-check.yml', 'reusable-supabase-release.yml']);
  assert.ok(active.length <= 5);
  for (const name of ['azure-moderation-ci', 'chat-v2-inbox-release', 'deploy-azure-moderation', 'deploy-google-moderation',
    'fsw-sec-003-evidence-audit', 'fsw-sec-003-prelaunch', 'fsw-sec-003-protected-release']) {
    assert.ok(existsSync(new URL(`../../docs/operations/archived-workflows/${name}.yml`, import.meta.url)), name);
    assert.ok(!existsSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url)), name);
  }
});

test('the private reusable release gates credentials by reviewed owner dispatch and target', () => {
  const yaml = workflow('reusable-supabase-release');
  assert.match(yaml, /github\.repository == 'vivek2310sharma\/FairSwap-Backend' && github\.event\.repository\.private == true/);
  assert.match(yaml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yaml, /github\.actor == 'vivek2310sharma'/);
  assert.match(yaml, /github\.triggering_actor == 'vivek2310sharma'/);
  assert.match(yaml, /inputs\.approved_sha == github\.sha/);
  assert.doesNotMatch(yaml, /^ {4}environment:|secrets\.CHAT_RELEASE_AUDIT_TOKEN|SERVICE_ROLE_KEY/m);
  const testJob = yaml.split('\n  test:\n')[1].split('\n  verify_test:\n')[0];
  const productionJob = yaml.split('\n  production:\n')[1];
  for (const [job, target, other] of [[testJob, 'TEST', 'PROD'], [productionJob, 'PROD', 'TEST']]) {
    for (const [context, suffix] of [['secrets', 'DB_PASSWORD'], ['secrets', 'DB_SSL_ROOT_CERT_PEM'], ['secrets', 'SUPABASE_ACCESS_TOKEN'], ['vars', 'DB_POOLER_HOST']]) {
      assert.ok(job.includes(`${context}.FAIRSWAP_${target}_${suffix}`));
      assert.ok(!job.includes(`${context}.FAIRSWAP_${other}_${suffix}`));
    }
  }
});

test('retired Chat and FSW workflows have only disabled roots and success-gated descendants', () => {
  for (const [name, roots] of [
    ['chat-v2-inbox-release', ['verify', 'audit_verify']],
    ['fsw-sec-003-protected-release', ['verify']],
    ['fsw-sec-003-prelaunch', ['verify']],
    ['fsw-sec-003-evidence-audit', ['audit']]
  ]) {
    const jobs = archived(name).split('\njobs:\n')[1].split(/\n(?=  [a-z_]+:\n)/);
    const blocked = new Set();
    const disabledRoots = [];
    for (const job of jobs) {
      const id = job.match(/^  ([a-z_]+):/)[1];
      const needs = job.match(/^    needs: (.+)$/m)?.[1];
      const condition = job.match(/^    if: [^\n]+(?:\n {6}[^\n]+)*/m)?.[0] ?? '';
      if (needs) {
        const dependencies = needs.replace(/[\[\]]/g, '').split(/,\s*/);
        assert.ok(dependencies.every(dependency => blocked.has(dependency)), `${name}/${id} needs a runnable job`);
        assert.doesNotMatch(condition, /(?:always|failure|cancelled)\s*\(/);
      } else {
        assert.match(condition, /^    if: >-\n      false &&/, `${name}/${id} must be disabled`);
        assert.doesNotMatch(condition, /\|\|/);
        disabledRoots.push(id);
      }
      blocked.add(id);
    }
    assert.deepEqual(disabledRoots, roots);
  }
});

test('cloud build and publish entry jobs are disabled and OIDC subjects stay environment-bound', () => {
  for (const [provider, entry] of [['azure', 'build-ci-and-publish'], ['google', 'build-and-verify']]) {
    const yaml = archived('deploy-' + provider + '-moderation');
    assert.ok(yaml.includes(`  ${entry}:\n    # Provider deployment is inactive. Keep the downstream environment-bound OIDC subjects.\n    if: \${{ false }}`));
    assert.match(yaml, /^    environment: FairSwapTest$/m);
    assert.match(yaml, /^    environment: FairSwapProd$/m);
    assert.doesNotMatch(yaml, /secrets\.(?:SUPABASE_(?:TEST_|PROD_)?SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)\b/);
  }
});
