import {readFileSync} from "node:fs";

const base = "supabase/forward-migrations/";
export async function setupOrdinaryGoodsFixture(exec, {beforeV3, providerNeutral = false} = {}) {
  const migrate = path => exec(readFileSync(path, "utf8"));
  await migrate("tests/taxonomy-v2/fixture.sql");
  await exec("alter table public.listings add column landmark text");
  await exec(`create schema vault;
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    create table public.app_system_settings(setting_key text primary key,setting_value text,description text);
    insert into public.app_system_settings(setting_key,setting_value) values('moderation_automation_enabled','true');`);
  await exec(`
    create table public.car_contract_versions(id uuid primary key,contract_key text not null);
    create table public.vehicle_contract_versions(id uuid primary key,contract_key text not null);
    create table public.car_category_contracts(category_id uuid,version_id uuid,source_path jsonb,fields jsonb);
    create table public.vehicle_category_contracts(category_id uuid,version_id uuid,source_path jsonb,fields jsonb);
  `);
  for (const path of [
    base+"posting-v2/supabase/migrations/20261025131116_posting_v2_mobiles.sql",
    base+"posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql",
    base+"accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql",
    base+"tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql",
    base+"wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql",
    base+"taxonomy-v2/supabase/migrations/20261117185218_taxonomy_v2_foundation.sql",
    base+"taxonomy-v2/catalogue/supabase/migrations/20261118092010_taxonomy_v2_catalogue.sql",
    "supabase/migrations/20261010090000_invalidate_resubmission_review_token.sql",
    "supabase/migrations/20261011000038_create_moderation_queue_and_results.sql",
    base+"moderation-azure-v1/20261104113705_azure_moderation_finalizer.sql",
    base+"moderation-switching-v1/20261104223000_moderation_provider_switching.sql",
    base+"wearables-v1/activation/supabase/migrations/20261104230000_activate_wearables_v1.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119092042_ordinary_goods_v3.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119100640_bounded_goods_v3.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119102359_pedal_and_parts_v3.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119103516_property_intake_v3.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119105021_regulated_vehicle_drafts_v3.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119111559_specialist_vehicle_draft_binding_v3.sql",
    base+"unified-publishing-v3/supabase/migrations/20261119114512_v3_require_active_seller_identity.sql",
  ]) {
    if (beforeV3 && path.endsWith('_ordinary_goods_v3.sql')) await beforeV3();
    try { await migrate(path); }
    catch (error) { throw Error(path + ": " + error.message, { cause: error }); }
  }
  if (providerNeutral) {
    await exec("alter table public.app_system_settings add column updated_at timestamptz default clock_timestamp()");
    await migrate(base+"moderation-google-cloud-v1/20261120000000_google_cloud_moderation_v1.sql");
    await migrate(base+"unified-publishing-v3/supabase/migrations/20261122213157_v3_provider_neutral_activation.sql");
  }
}
