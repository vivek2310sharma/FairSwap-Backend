# FairSwap unified email branding — 22 October 2026

## Scope and source

Backend is the canonical source for hosted Supabase Auth templates, not Web's tracked mirrors. This change uses the existing public Web logo at `https://fairswap.in/brand/FairSwap_Web_Logo_Transparent.png`, preserves signup and recovery `TokenHash` callbacks, the existing 6-digit sign-in code, 600-second local OTP lifetime, SMTP settings, and the email-outbox worker's delivery/idempotency logic. No database migration, new email provider, payment/escrow capability, or login behavior change.

**Template inventory:** 6 Auth action templates (confirmation, magic_link/OTP, recovery, invite, email_change, reauthentication); 7 security notification templates (password_changed, email_changed, phone_changed, identity_linked, identity_unlinked, mfa_factor_enrolled, mfa_factor_unenrolled); 3 listing outbox cases (submitted_for_review, approved, rejected). Security notification enablement is *not* changed in `config.toml` or hosted projects; disabled types remain disabled.

**Asset ownership:** The logo is hosted by Web (`public/brand/FairSwap_Web_Logo_Transparent.png`). Keep its URL public and stable; do not delete or change it without reviewing affected emails. When email clients block remote images, the alt text and visible tagline still identify FairSwap.

## Safe verification

1. Run `node scripts/verify-email-branding.mjs` in Backend. This checks source-level placeholders, image, responsive HTML, and worker wiring; it does not send mail.
2. Review output from controlled offline HTML previews in mobile Gmail/Outlook and image-disabled mode. Check existing calls to `renderEmailTemplate` for injected user text and expected listing links.
3. After the Backend PR is reviewed/merged, advance the **exact Web mirror pin** and sync its 3 tracked Auth templates, local config and shared outbox worker, plus update the Web auth-template test which previously banned all `img` tags. Never directly edit pinned mirrors as a standalone Web source of truth.
4. **Hosted Supabase Auth is FROZEN as of 18 October.** Merging this PR does NOT update FairSwapTest/Prod hosted templates. Do not use the legacy Web `apply` tools, `supabase config push`, or Edge deploy while that freeze is in force.
5. When the owner separately approves a Backend-only release process, back up only the existing Auth template/subject settings per environment, deploy **FairSwapTest first**, verify 6-digit sign-in OTP, signup confirmation, recovery, invitations, email change, reauthentication and any enabled security notifications with controlled addresses; verify inbox rendering, expired tokens, callbacks, and bounce monitoring. Then, with separate Production release approval, roll out to FairSwapProd. Use authorized Backend-owned operator tooling; never save or log credentials/tokens.
6. Deploy the `process-email-outbox` Edge bundle only through the approved Backend release process and test one controlled event of each existing type on Test before Production. Revert to the saved previous bundle on failure. No activation of unrelated security notifications or automation switches.

## Security and fraud prevention

Trusted URLs: `https://fairswap.in` and `https://help.fairswap.in`. No tracking pixels, remote fonts, or new third-party hosts. Account-action links stay Supabase-generated or retain existing first-party callbacks. Reminder: never share OTPs or pay an advance to verify a buyer. Audit callback behavior on Android/iOS before any change to redirect contracts. Brand consistency and direct first-party links differentiate FairSwap from less trusted classifieds experiences.

**Evidence:** Auth template source audit and direct code inspections. Hosted configuration update: **NOT RUN**. Real inbox test: **NOT RUN**. Edge deployment: **NOT RUN**.
