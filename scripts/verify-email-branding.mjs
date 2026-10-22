// Offline, read-only source verification; does not contact Supabase or send mail.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const names = ["confirm_email.html","magic_link.html","recovery_email.html","invite_email.html","email_change.html","reauthentication.html","password_changed_notification.html","email_changed_notification.html","phone_changed_notification.html","identity_linked_notification.html","identity_unlinked_notification.html","mfa_factor_enrolled_notification.html","mfa_factor_unenrolled_notification.html"];
const read = (name) => readFileSync(new URL("../supabase/templates/" + name, import.meta.url), "utf8");
for (const name of names) {
 const html = read(name);
 assert.ok(html.includes("https://fairswap.in/brand/FairSwap_Web_Logo_Transparent.png"),name+": logo missing");
 assert.ok(html.includes('alt="FairSwap"'),name+": accessible logo missing");
 assert.ok(html.includes("Give. Get. Grow Together."),name+": tagline missing");
 assert.ok(html.includes('<table role="presentation"'),name+": email-client table missing");
 assert.ok(html.includes('name="viewport"'),name+": mobile viewport missing");
 assert.ok(!/<script[ >]/i.test(html),name+": executable script");
}
const confirmation = read("confirm_email.html");
const recovery = read("recovery_email.html");
const otp = read("magic_link.html");
assert.equal(confirmation.split("{{ .TokenHash }}").length,2);
assert.equal(recovery.split("{{ .TokenHash }}").length,2);
assert.equal(otp.split("{{ .Token }}").length,2);
assert.ok(confirmation.includes("type=signup&amp;next=/account"));
assert.ok(recovery.includes("type=recovery&amp;next=/auth/reset-password"));
assert.ok(!otp.includes("{{ .TokenHash }}"));
for(const n of ["invite_email.html","email_change.html"])assert.ok(read(n).includes("{{ .ConfirmationURL }}"));
assert.ok(read("reauthentication.html").includes("{{ .Token }}"));
const config=readFileSync(new URL("../supabase/config.toml",import.meta.url),"utf8");
assert.ok(config.includes("otp_expiry = 600"));
assert.ok(config.includes("otp_length = 6"));
assert.equal((config.match(/content_path =/g)||[]).length,names.length);
const worker=readFileSync(new URL("../supabase/functions/_shared/email-outbox-worker.ts",import.meta.url),"utf8");
assert.ok(worker.includes("brandListingEmail(rendered.html)"));
assert.ok(worker.includes("Idempotency-Key"));
console.log("PASS: " + names.length + " branded Auth templates, security placeholders, and outbox wiring (source-level only)");
