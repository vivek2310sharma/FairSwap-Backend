// Disposable PGlite, no Supabase credentials or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(resolve(process.argv[2] ?? "tests/ratings", "package.json"));
const { PGlite } = require("@electric-sql/pglite");
const db = new PGlite();
const base = "supabase/forward-migrations/";
const migrate = path => db.exec(readFileSync(path, "utf8"));
try {
  await migrate("tests/taxonomy-v2/fixture.sql");
  await db.exec("alter table public.listings add column landmark text");
  await db.exec(`create schema vault;
    create table vault.decrypted_secrets(name text,decrypted_secret text);
    create table public.app_system_settings(setting_key text primary key,setting_value text,description text);
    insert into public.app_system_settings(setting_key,setting_value) values('moderation_automation_enabled','true');`);
  await db.exec(`
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
    try { await migrate(path); }
    catch (error) { throw Error(path + ": " + error.message, { cause: error }); }
  }

  await db.exec(`create or replace function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object('role',current_setting('role',true))
  $$;
  create or replace function public.seller_submit_listing(uuid) returns jsonb language sql
  as $$select app_security.impl_seller_submit_listing($1)$$;`);
  const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
  const role = async (name, user="") => {
    await db.exec("reset role");
    await db.query("select set_config('request.user',$1,false)",[user]);
    await db.exec("set role " + name);
  };
  const moderationSource=readFileSync("supabase/migrations/20260914000008_create_listing_rpcs.sql","utf8");
  const approvalStart=moderationSource.indexOf("CREATE OR REPLACE FUNCTION app_security.impl_moderate_listing(");
  const approvalEnd=moderationSource.indexOf("CREATE OR REPLACE FUNCTION public.moderate_listing(",approvalStart);
  assert(approvalStart>=0 && approvalEnd>approvalStart);
  await db.exec(moderationSource.slice(approvalStart,approvalEnd));
  await migrate("supabase/migrations/20261007153744_atomic_reviewed_moderation.sql");
  await migrate("supabase/migrations/20261010080000_remediate_legacy_moderate_listing.sql");
  await db.exec(`create or replace function app_security.is_active_staff_aal2(public.staff_role_enum)
    returns boolean language sql stable as $$select current_setting('request.fixture_aal2',true)='yes' and auth.uid() is not null$$`);
  const owner = "00000000-0000-4000-8000-000000000011";
  const other = "00000000-0000-4000-8000-000000000012";
  const city = "00000000-0000-4000-8000-000000000013";
  const locality = "00000000-0000-4000-8000-000000000014";
  await db.query("insert into auth.users values ($1),($2)",[owner,other]);
  await db.query("insert into public.cities values ($1,true,'Bengaluru','Karnataka')",[city]);
  await db.query("insert into public.localities values ($1,$2,true,'Locality')",[locality,city]);
  await db.query("insert into public.postal_pincode_localities values ('560001',$1)",[locality]);
  await db.exec(`update public.app_system_settings set setting_value='true' where setting_key='moderation_azure_enabled';
    create table public.property_category_contracts(category_id uuid);
    create table public.listing_car_contexts(listing_id uuid);
    create table public.listing_vehicle_contexts(listing_id uuid);
    create table public.listing_property_contexts(listing_id uuid);`);
  const inventory=JSON.parse(readFileSync("docs/publishing/unified-v3-subtype-bindings.json","utf8"));
  const representative={
    "v2-cars":{legacy:"car-hatchback", prefix:"car", key:"cars-draft-v1"},
    "v2-motorcycles-scooters":{legacy:"tw-commuter-bikes", prefix:"vehicle", key:"two-wheeler-draft-v1"},
  };
  async function installReference(config,environment) {
    const row=inventory[environment].find(r=>r.slug===config.legacy);
    await db.query("insert into public.categories(id,slug,name,macro_category,is_active,new_listing_enabled) values($1,$2,$2,'vehicles',false,false)",[row.id,row.slug]);
    await db.query(`insert into public.${config.prefix}_contract_versions values($1,$2) on conflict do nothing`,[row.version_id,config.key]);
    await db.query(`insert into public.${config.prefix}_category_contracts values($1,$2,$3,$4)`,
      [row.id,row.version_id,JSON.stringify(row.path),JSON.stringify(row.fields)]);
    return row;
  }
  for (const config of Object.values(representative)) await installReference(config,"test");
  const definitions=(await db.query("select * from app_security.ordinary_goods_contracts_v3 order by slug")).rows;
  assert.equal(definitions.length,58);
  assert.equal(definitions.filter(x=>x.enabled).length,0);
  await role("anon");
  await assert.rejects(db.query("select public.ordinary_goods_v3()"), /permission denied/);
  await role("authenticated",owner);
  assert.deepEqual(await scalar("select public.ordinary_goods_v3()"),{});
  await assert.rejects(db.query("select * from app_security.ordinary_goods_sessions_v3"),/permission denied/);
  await assert.rejects(db.query("select public.ordinary_goods_session_v3('v2-books',gen_random_uuid(),'create')"),/ORDINARY_GOODS_CONTRACT_UNAVAILABLE/);
  await db.exec("reset role");
  assert.equal(await scalar("select count(*)::integer from app_security.ordinary_goods_contracts_v3 g join public.categories c on c.id=g.category_id and c.slug=g.slug where not c.new_listing_enabled"),58);

  // Test operator activation transaction on one leaf. Identity hooks here are
  // synthetic so this proves activation conditions, never hosted IDV behavior.
  const activation = readFileSync(base+"unified-publishing-v3/activate-one.operator.sql","utf8")
    .split("\n").filter(line=>!line.startsWith("\\")).join("\n")
    .replace(":'moderation_mode'","'five_check'").replace(":'slug'","'v2-books'").replace(":'web_commit'","'"+"a".repeat(40)+"'");
  await assert.rejects(db.exec(activation),/GOODS_LISTING_OR_IDENTITY_GUARDS_MISSING/);
  await db.exec("rollback");
  await db.exec(`create function app_security.enforce_verified_actor(uuid,boolean) returns void language plpgsql as $$
    begin if current_setting('request.identity',true)='false' then raise exception 'IDENTITY_VERIFICATION_REQUIRED'; end if; end$$;
    create function app_security.trg_identity_gate_listings() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger trg_identity_gate before insert on public.listings for each row execute function app_security.trg_identity_gate_listings();
    create function app_security.trg_identity_gate_by_listing() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger trg_identity_gate before insert on public.listing_media for each row execute function app_security.trg_identity_gate_by_listing();
    create function app_security.trg_identity_gate_posting_session() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger trg_identity_gate before insert on public.posting_upload_sessions for each row execute function app_security.trg_identity_gate_posting_session();
    create function app_security.trg_identity_gate_staged_media() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger trg_identity_gate before insert on public.posting_staged_media for each row execute function app_security.trg_identity_gate_staged_media();`);
  await assert.rejects(db.exec(activation),/GOODS_SELLER_IDENTITY_ENFORCEMENT_OFF/);
  await db.exec("rollback");
  await db.exec("insert into public.app_system_settings values ('identity_verification_required','true','Fixture enforcement')");
  const intake = activation.replace("'five_check', true)", "'staff_intake', true)");
  await db.exec("update public.app_system_settings set setting_value='false' where setting_key='moderation_azure_enabled'");
  await assert.rejects(db.exec(activation),/GOODS_FIVE_CHECK_MODERATION_NOT_READY/);
  await db.exec("rollback");
  await db.exec(intake);
  const activateBicycle = sql => sql.replace("'v2-books'", "'v2-bicycles'");
  await assert.rejects(db.exec(activateBicycle(activation)), /GOODS_CATEGORY_DRIFT/);
  await db.exec("rollback");
  await db.exec(activateBicycle(intake));
  assert.equal(await scalar("select moderation_mode from app_security.ordinary_goods_contracts_v3 where slug='v2-bicycles'"),"staff_intake");
  await db.exec("update public.app_system_settings set setting_value='true' where setting_key='moderation_azure_enabled'");

  assert.deepEqual(Object.keys(await scalar("select app_security.ordinary_goods_read_v3(null)")).sort(),["v2-bicycles","v2-books"]);
  await role("authenticated",owner);
  await db.exec("select set_config('request.identity','false',false)");
  await assert.rejects(db.query("select public.ordinary_goods_session_v3('v2-books',gen_random_uuid(),'create')"),/IDENTITY_VERIFICATION_REQUIRED/);
  await db.exec("select set_config('request.identity','true',false);reset role");

  const gated = new Set(["v2-baby-gear-car-seats", "v2-other-items"]);
  for (const d of definitions.filter(row => gated.has(row.slug))) {
    await assert.rejects(db.exec(activation.replace("'v2-books'", "'" + d.slug + "'")), /GOODS_CATEGORY_DRIFT/);
    await db.exec("rollback");
    await db.query("update app_security.ordinary_goods_contracts_v3 set enabled=true where category_id=$1",[d.category_id]);
    assert.equal(await scalar("select app_security.ordinary_goods_available_v3($1)",[d.category_id]),false);
  }
  assert.equal(await scalar("select count(*)::integer from public.categories c join public.categories p on p.id=c.parent_id where p.slug like 'v2-%' and c.posting_flow is not null"),63);
  for (const slug of ["v2-dogs", "v2-other-pets"]) {
    const id=await scalar("select id from public.categories where slug=$1",[slug]);
    assert.ok(id);
    assert.equal(await scalar("select app_security.impl_taxonomy_v2_can_post($1)",[id]),false);
  }
  for (const slug of ["v2-services","v2-jobs"]) {
    assert.equal(await scalar("select count(*)::integer from public.categories c join public.categories p on p.id=c.parent_id where p.slug=$1",[slug]),0);
  }
  const eligible = definitions.filter(row => !gated.has(row.slug));
  // Exercise every canonical mapping against the real taxonomy predicate.
  for (const d of eligible) {
    await db.query("update public.categories set is_active=true,status='live' where id=$1",[d.category_id]);
    await db.query("update app_security.ordinary_goods_contracts_v3 set enabled=true where category_id=$1",[d.category_id]);
    assert.equal(await scalar("select app_security.impl_taxonomy_v2_can_post($1)",[d.category_id]),true);
  }
  assert.equal(Object.keys(await scalar("select app_security.ordinary_goods_read_v3(null)")).length,56);
  await db.exec("update public.app_system_settings set setting_value='false' where setting_key='identity_verification_required'");
  assert.deepEqual(await scalar("select app_security.ordinary_goods_read_v3(null)"),{});
  await role("authenticated",owner);
  await assert.rejects(db.query("select public.ordinary_goods_session_v3('v2-books',$1,'create')",[owner]),/ORDINARY_GOODS_CONTRACT_UNAVAILABLE/);
  await db.exec("reset role");
  await db.exec("update public.app_system_settings set setting_value='true' where setting_key='identity_verification_required'");
  console.log("PASS installed helper and hooks do not admit posting with identity enforcement off");

  for (const [i,d] of eligible.entries()) {
    const session = `00000000-0000-4000-8000-${String(100+i).padStart(12,"0")}`;
    const media = `00000000-0000-4000-8000-${String(200+i).padStart(12,"0")}`;
    await role("authenticated",owner);
    const created = await scalar("select public.ordinary_goods_session_v3($1,$2,'create')",[d.slug,session]);
    const listing = created.session.listing_id;
    assert.equal(created.session.owner_id,owner);
    await assert.rejects(db.query("select public.ordinary_goods_session_v3($1,$2,'read')",[d.slug === "v2-books" ? "v2-tvs" : "v2-books",session]),/UPLOAD_SESSION_UNAVAILABLE/);
    await assert.rejects(db.query("select public.posting_v2_session($1,'read',null)",[session]),/UPLOAD_SESSION_UNAVAILABLE/);
    await role("authenticated",other);
    await assert.rejects(db.query("select public.ordinary_goods_session_v3($1,$2,'read')",[d.slug,session]),/UPLOAD_SESSION_UNAVAILABLE/);
    await role("authenticated",owner);
    const payload = {
      slug:d.slug, category_id:d.category_id, revision:1, session_id:session, media_ids:[media],
      title:"Sample item in good condition", description:"Carefully used for two years.", condition:"good",
      price_type:i%2 ? "negotiable" : "free", price_paise:i%2 ? 50000 : 0, pin_code:"560001", city_id:city, locality_id:locality,
      answers:{safety_confirmed:true, defects:"", power_safe:true,
        ...Object.fromEntries(d.fields.filter(f=>f.required).map(f=>[f.key,f.kind==="number"?f.min:f.choices?.[0] ?? "Sample"]))},
    };
    const property = d.macro_category === "property";
    if (property) {
      payload.condition = payload.price_type = payload.price_paise = null;
      payload.answers.amount_paise = 3_125_000_001;
      if (d.fields.find(f => f.key === "offer").choices.includes("Sale")) payload.answers.offer = "Sale";
    }
    const prepare = value => scalar("select public.ordinary_goods_prepare_v3($1::jsonb)",[JSON.stringify(value)]);
    const submit = value => scalar("select public.ordinary_goods_submit_v3($1::jsonb)",[JSON.stringify(value)]);
    if (d.draft_only) {
      const specialist = representative[d.slug];
      if (specialist) {
        const ref=inventory.test.find(r=>r.slug===specialist.legacy);
        await db.exec("reset role");
        assert.deepEqual(await scalar("select specialist_binding from app_security.ordinary_goods_sessions_v3 where session_id=$1",[session]),[ref.id,ref.version_id]);
        await db.query(`update public.${specialist.prefix}_category_contracts set fields='[]' where category_id=$1`,[ref.id]);
        assert.equal(await scalar("select app_security.ordinary_goods_available_v3($1)",[d.category_id]),false);
        await role("authenticated",owner);
        await assert.rejects(db.query("select public.ordinary_goods_session_v3($1,$2,'read')",[d.slug,session]),/UPLOAD_SESSION_UNAVAILABLE/);
        await db.exec("reset role");
        await db.query(`update public.${specialist.prefix}_category_contracts set fields=$2 where category_id=$1`,[ref.id,JSON.stringify(ref.fields)]);
        await db.query(`delete from public.${specialist.prefix}_category_contracts where category_id=$1`,[ref.id]);
        await db.query("delete from public.categories where id=$1",[ref.id]);
        const prod=await installReference(specialist,"prod");
        assert.deepEqual(await scalar("select app_security.specialist_vehicle_draft_binding_v3($1)",[d.category_id]),[prod.id,prod.version_id]);
        await role("authenticated",owner);
        await assert.rejects(db.query("select public.ordinary_goods_session_v3($1,$2,'read')",[d.slug,session]),/UPLOAD_SESSION_UNAVAILABLE/);
        await db.exec("reset role");
        await db.query(`delete from public.${specialist.prefix}_category_contracts where category_id=$1`,[prod.id]);
        await db.query("delete from public.categories where id=$1",[prod.id]);
        await installReference(specialist,"test");
        await role("authenticated",owner);
      }
      const reserved = await scalar("select public.ordinary_goods_session_v3($1,$2,'reserve',$3)",[d.slug,session,media]);
      await role("service_role");
      assert.equal(await scalar("select public.posting_v2_media_ready($1,$2,$3,400,20,20)",[session,media,reserved.media[0].attempt]),true);
      await role("authenticated",owner);
      assert.equal((await scalar("select public.ordinary_goods_session_v3($1,$2,'read')",[d.slug,session])).media[0].state,"ready");
      for (const description of ["Certified exempt based on top speed.", "Registered electric scooter."]) {
        await assert.rejects(prepare({...payload,description}),/REGULATED_VEHICLE_DRAFT_ONLY/);
        await assert.rejects(submit({...payload,description}),/REGULATED_VEHICLE_DRAFT_ONLY/);
      }
      await db.exec("reset role");
      await role("authenticated",owner);
      for (const answers of [
        { ...payload.answers, authority: "Registered owner", registration: "Registered in India" },
        { ...payload.answers, authority: "Authorised representative", eligibility_verified: true },
        { ...payload.answers, verification: { owner_id: other, verified_at: "2000-01-01", subtype_id: listing, version_id: media } },
      ]) {
        await assert.rejects(prepare({...payload,answers}),/REGULATED_VEHICLE_DRAFT_ONLY/);
        await assert.rejects(submit({...payload,answers}),/REGULATED_VEHICLE_DRAFT_ONLY/);
      }
      await role("service_role");
      await assert.rejects(db.query("select public.ordinary_goods_submit_v3($1::jsonb)",[JSON.stringify(payload)]),/permission denied/);
      await db.exec("reset role");
      assert.equal(await scalar("select count(*)::integer from public.listing_moderation_requests where listing_id=$1",[listing]),0);
      assert.equal(await scalar("select frozen_payload from app_security.ordinary_goods_sessions_v3 where session_id=$1",[session]),null);
      await assert.rejects(db.query("insert into public.listings(id,seller_id,category_id,title,status) values($1,$2,$3,'Bypass','active')",[listing,owner,d.category_id]),/REGULATED_VEHICLE_DRAFT_ONLY/);
      await db.query("update public.posting_upload_sessions set expires_at=now()-interval '1 minute' where id=$1",[session]);
      await role("authenticated",owner);
      await assert.rejects(db.query("select public.ordinary_goods_session_v3($1,$2,'reserve',$3)",[d.slug,session,media]),/UPLOAD_SESSION_EXPIRED/);
      console.log("PASS",d.slug,"owned draft photo recovery, expiry and blocked submission");
      continue;
    }
    await assert.rejects(prepare({...payload,revision:2}),/ORDINARY_GOODS_CONTRACT_UNAVAILABLE/);
    await assert.rejects(prepare({...payload,category_id:definitions.find(x=>x!==d).category_id}),/ORDINARY_GOODS_CONTRACT_UNAVAILABLE/);
    await assert.rejects(prepare({...payload,description:"Send an advance payment via UPI before viewing."}),/payment/i);
    await assert.rejects(prepare({...payload,description:"Device with a swollen battery."}),/ORDINARY_GOODS_BLOCKED_CONTENT|ORDINARY_GOODS_PEDAL_ONLY/);
    await assert.rejects(prepare({...payload,description:"Live animals for sale."}),/ORDINARY_GOODS_BLOCKED_CONTENT/);
    if (d.slug === "v2-bicycles") {
      await assert.rejects(prepare({...payload,description:"Includes an electric conversion kit."}),/ORDINARY_GOODS_PEDAL_ONLY/);
    }
    if (property) {
      if (payload.answers.offer === "Sale") {
        await assert.rejects(prepare({...payload,answers:{...payload.answers,deposit_paise:50_000}}),/PROPERTY_SALE_RENT_TERMS_FORBIDDEN/);
      }
      await assert.rejects(prepare({...payload,price_paise:100}),/PROPERTY_ITEM_TERMS_FORBIDDEN/);
      await assert.rejects(prepare({...payload,description:"Visit unit number 23B."}),/PROPERTY_PRIVATE_OR_UNVERIFIED_CONTENT/);
      await assert.rejects(prepare({...payload,answers:{...payload.answers,amount_paise:100.5}}),/PROPERTY_INTEGER_TERMS_REQUIRED/);
      await assert.rejects(prepare({...payload,answers:{...payload.answers,amount_paise:1_000_000_000_001}}),/ORDINARY_GOODS_INVALID_FIELD/);
    }
    const choiceField = d.fields.find(f => f.choices);
    if (choiceField) await assert.rejects(prepare({...payload,answers:{...payload.answers,[choiceField.key]:"Unlisted subtype"}}),/ORDINARY_GOODS_INVALID_FIELD/);
    await assert.rejects(prepare(payload),/ORDINARY_GOODS_INVALID_MEDIA/);
    const reserved = await scalar("select public.ordinary_goods_session_v3($1,$2,'reserve',$3)",[d.slug,session,media]);
    await assert.rejects(prepare(payload),/ORDINARY_GOODS_INVALID_MEDIA/);
    await role("service_role");
    assert.equal(await scalar("select public.posting_v2_media_ready($1,$2,$3,400,20,20)",[session,media,reserved.media[0].attempt]),true);
    await role("authenticated",owner);
    assert.equal((await prepare(payload)).session.state,"finalizing");
    await assert.rejects(prepare({...payload,title:"Changed pending title"}),/ORDINARY_GOODS_FROZEN_CONFLICT/);
    await assert.rejects(submit(payload),/ORDINARY_GOODS_MEDIA_NOT_PREPARED/);
    await db.exec("reset role");
    for (const name of ["original","thumb","medium","large"]) {
      await db.query("insert into storage.objects values ($1,$2)",[name==="original"?"listing-originals":"listing-derivatives",`${listing}/${media}/${name}.webp`]);
    }
    await role("authenticated",owner);
    assert.deepEqual(await submit(payload),{success:true,listing_id:listing});
    assert.deepEqual(await submit(payload),{success:true,listing_id:listing});
    assert.equal(await scalar("select category_id from public.listings where id=$1",[listing]),d.category_id);
    if (property) {
      assert.equal(await scalar("select category_attributes->>'amount_paise' from public.listings where id=$1",[listing]),"3125000001");
      assert.equal(await scalar("select price_paise is null and price_type is null and condition is null from public.listings where id=$1",[listing]),true);
    }
    await assert.rejects(db.query("insert into public.listings(seller_id,category_id,title) values($1,$2,'Direct attempt')",[owner,d.category_id]),/ORDINARY_GOODS_BOUND_SESSION_REQUIRED|row-level security/);
    await role("service_role");
    await assert.rejects(db.query("select public.ordinary_goods_submit_v3($1)",[JSON.stringify(payload)]),/permission denied/);
    await db.exec("reset role");
    assert.equal(await scalar("select status from public.listings where id=$1",[listing]),"pending_review");
    assert.equal(await scalar("select count(*)::integer from public.listing_media where listing_id=$1",[listing]),1);
    await assert.rejects(db.query("update public.listings set status='active' where id=$1",[listing]),/ORDINARY_GOODS_CURRENT_CLEAN_SCAN_REQUIRED|GOODS_STAFF_INTAKE_PUBLICATION_DISABLED/);
    await assert.rejects(db.query("update public.listings set landmark='Private data' where id=$1",[listing]),/ORDINARY_GOODS_INVALID_LOCATION/);
    assert.equal(await scalar("select count(*)::integer from public.listing_moderation_requests where listing_id=$1",[listing]),1);
    const request=(await db.query("select id,generation_id,listing_revision from public.listing_moderation_requests where listing_id=$1",[listing])).rows[0];
    const ticket = "00000000-0000-4000-8000-000000000041";
    const checks = ["check_india_fraud_rules","check_openai_moderation","check_vision_nsfw","check_vision_category","check_ocr_qr"];
    const finalize = () => scalar(`select app_security.impl_finalize_moderation_result(
      $1,$2,'no_review_flags','india_v1.0.0','multimodal_five_check',$3::text[],array[]::text[],'[]','[]')`,[request.id,ticket,checks]);
    await db.query("update public.listing_moderation_requests set status='claimed',claim_token=$2,claim_expires_at=now()+interval '5 minutes' where id=$1",[request.id,ticket]);
    assert.equal((await finalize()).decision,"awaiting_retry");
    assert.equal(await scalar("select status from public.listings where id=$1",[listing]),"pending_review");
    await db.query("update public.listing_moderation_requests set status='claimed',claim_token=$2,claim_expires_at=now()+interval '5 minutes' where id=$1",[request.id,ticket]);
    const path=`${listing}/${media}/original.webp`;
    const hash="a".repeat(64);
    await db.query(`insert into app_security.listing_media_verified_hashes(media_id,listing_id,original_storage_path,content_sha256,generation_id)
      values($1,$2,$3,$4,$5)`,[media,listing,path,hash,request.generation_id]);
    await db.query(`insert into app_security.listing_moderation_scan_receipts(request_id,listing_id,listing_revision,generation_id,
      media_digest,verdict,ruleset_version,scope,completed_checks,manifest,scanned_media_count)
      values($1,$2,$3,$4,$5,'APPROVE','india_v1.0.0','multimodal_five_check',$6::text[],$7::jsonb,1)`,
      [request.id,listing,request.listing_revision,request.generation_id,hash,checks,JSON.stringify([{id:media,path,sha256:hash}])]);
    const staffApprove = revision => scalar("select public.moderate_listing_reviewed($1,'approve',null,$2,'pending_review')",[listing,revision]);
    if (i===0 || d.slug==="v2-books") {
      await role("authenticated",other);
      await db.exec("select set_config('request.fixture_aal2','yes',false)");
      await assert.rejects(staffApprove(request.listing_revision+1),/MODERATION_REVIEW_CONFLICT/);
      await assert.rejects(staffApprove(request.listing_revision),/GOODS_STAFF_INTAKE_PUBLICATION_DISABLED|ORDINARY_GOODS_CURRENT_CLEAN_SCAN_REQUIRED/);
      await db.exec("reset role");
    }
    if (d.slug === "v2-books" || d.macro_category === "vehicles" || property) {
      assert.equal((await finalize()).decision,"routed_to_admin");
      assert.equal(await scalar("select status from public.listings where id=$1",[listing]),"pending_review");
      await assert.rejects(db.query("update public.listings set status='active' where id=$1",[listing]),/GOODS_STAFF_INTAKE_PUBLICATION_DISABLED/);
      if (d.slug==="v2-books") {
        await role("authenticated",other);
        await assert.rejects(staffApprove(request.listing_revision),/GOODS_STAFF_INTAKE_PUBLICATION_DISABLED/);
        await assert.rejects(staffApprove(request.listing_revision),/GOODS_STAFF_INTAKE_PUBLICATION_DISABLED/);
        await db.exec("reset role");
        assert.equal(await scalar("select status from public.listings where id=$1",[listing]),"pending_review");
      }
      console.log("PASS", d.slug, "staff intake blocks publication even with a five-check result");
      continue;
    }
    assert.equal((await finalize()).decision,"auto_approved");
    assert.equal(await scalar("select status from public.listings where id=$1",[listing]),"active");
    await assert.rejects(db.query("update public.listings set revision=revision+1 where id=$1",[listing]),/ORDINARY_GOODS_CURRENT_CLEAN_SCAN_REQUIRED/);
    if (i===0) {
      await role("authenticated",other);
      await assert.rejects(staffApprove(request.listing_revision),/MODERATION_REVIEW_CONFLICT/);
      await db.exec("reset role");
      console.log("PASS staff approval before and after worker approval is blocked for current and stale snapshots");
      await db.query("update public.listings set status='pending_review',revision=revision+1 where id=$1",[listing]);
      await db.exec("update public.app_system_settings set setting_value='false' where setting_key='moderation_azure_enabled'");
      const next=(await db.query("select id,generation_id,listing_revision from public.listing_moderation_requests where listing_id=$1 and status='pending'",[listing])).rows[0];
      await db.query("update public.listing_moderation_requests set status='claimed',claim_token=$2,claim_expires_at=now()+interval '5 minutes' where id=$1",[next.id,ticket]);
      await db.query(`insert into app_security.listing_media_verified_hashes(media_id,listing_id,original_storage_path,content_sha256,generation_id)
        values($1,$2,$3,$4,$5)`,[media,listing,path,hash,next.generation_id]);
      await db.query(`insert into app_security.listing_moderation_scan_receipts(request_id,listing_id,listing_revision,generation_id,
        media_digest,verdict,ruleset_version,scope,completed_checks,manifest,scanned_media_count)
        values($1,$2,$3,$4,$5,'APPROVE','india_baseline_v1.0.0','baseline_two_check',$6::text[],$7::jsonb,1)`,
        [next.id,listing,next.listing_revision,next.generation_id,hash,checks.slice(0,2),JSON.stringify([{id:media,path,sha256:hash}])]);
      const result=await scalar(`select app_security.impl_finalize_moderation_result(
        $1,$2,'no_review_flags','india_baseline_v1.0.0','baseline_two_check',$3::text[],array[]::text[],'[]','[]')`,[next.id,ticket,checks.slice(0,2)]);
      assert.equal(result.decision,"routed_to_admin");
      assert.equal(await scalar("select status from public.listings where id=$1",[listing]),"pending_review");
      await db.exec("update public.app_system_settings set setting_value='true' where setting_key='moderation_azure_enabled'");
      console.log("PASS provider fallback queues Goods for staff without publishing");
    }
    console.log("PASS",d.slug,"session, ownership, photo readiness, atomic submit, idempotency and publication gate");
  }
  console.log("PASS 58 disabled defaults, 52 end-to-end SQL fixture submissions and four protected draft-only journeys, two forced gates and negative boundaries");
} catch (error) {
  console.error(error.message, error.cause?.message ?? "", error.where ?? "");
  process.exitCode=1;
} finally { await db.close(); }
