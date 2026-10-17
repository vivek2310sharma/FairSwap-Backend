// Offline-only hash/scope checker for the proposed cold Production category foundation.
// Does not run SQL, contact Supabase, or assert live production readiness.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root=fileURLToPath(new URL("../../",import.meta.url));
const m=JSON.parse(readFileSync(path.join(root,"releases/production-candidate/candidate-manifest.json"),"utf8"));
const lines=readFileSync(path.join(root,"docs/extraction/MIGRATION_MANIFEST.sha256"),"utf8").trim().split("\n");
const original=new Map(lines.map(l=>{const x=/^([a-f0-9]{64})  (supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql)$/.exec(l);if(!x)throw Error("Invalid canonical manifest line");return [x[2],x[1]]}));
const expected=["supabase/migrations/20261009201151_two_wheeler_draft_v1.sql","supabase/migrations/20261009202059_two_wheeler_catalogue_lookup.sql","supabase/migrations/20261009203141_two_wheeler_unresolved_mapping_correction.sql","supabase/migrations/20261009215128_two_wheeler_reference_errors.sql","supabase/migrations/20261010064518_car_draft_v1.sql","supabase/migrations/20261010084523_property_rental_draft_v1.sql","supabase/migrations/20261010091239_property_scoped_draft_lock.sql"];
if(m.mode!=="draft_schema_cold_foundation_candidate"||m.allow_automatic_execution!==false||m.published!==false||m.existing_prod_baseline_count!==45)throw Error("Unsafe candidate release mode");
if(lines.length!==58||original.size!==58)throw Error("Canonical source manifest no longer matches 58-file baseline");
if(JSON.stringify(m.selected_migrations.map(x=>x.path))!==JSON.stringify(expected))throw Error("Selected migration order/scope changed");
for(const entry of m.selected_migrations){
 if(!/^[a-f0-9]{64}$/.test(entry.sha256)||original.get(entry.path)!==entry.sha256)throw Error("Expected checksum not in canonical manifest: "+entry.path);
 const bytes=readFileSync(path.join(root,entry.path));
 if(createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw Error("Source bytes changed: "+entry.path);
}
if(m.excluded_source_migrations.length!==6||m.excluded_hosted_test_versions.length!==3)throw Error("Excluded-source safety list changed");
for(const name of m.excluded_source_migrations){
 if(!original.has("supabase/migrations/"+name)||m.selected_migrations.some(x=>x.path.endsWith(name)))throw Error("Unsafe Test-only migration scope: "+name);
}
for(const version of ["20261010214201","20261017125456","20261017172840"]){
 if(!m.excluded_hosted_test_versions.includes(version))throw Error("Test-only hosted migration omission: "+version);
}
const blocklist=["enable_test","_test_family_submission","post_ad_current_base_compatibility","stage3_experimental_finalizer","fairswaptest_restore"];
if(m.selected_migrations.some(x=>blocklist.some(w=>x.path.includes(w))))throw Error("Activation/test-only SQL in production scope");
console.log("PASS: 7 pinned candidate source blobs; 6 source and 3 hosted Test-only changes excluded; no SQL executed");
