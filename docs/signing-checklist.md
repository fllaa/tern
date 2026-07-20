# Code-signing logistics checklist

Signing is wall-clock-bound (identity verification, account reviews), which is
why the dev plan starts it in Phase 0 even though nothing ships until Phase 6.
Everything here is **maintainer homework** — none of it blocks development.
Unsigned builds are fine for the entire beta period.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

## A. macOS — Apple Developer Program (start this week)

- [ ] Enroll at <https://developer.apple.com/programs/enroll/> as an
      **individual** ($99/yr). No D-U-N-S number needed. Identity verification
      usually takes 1–2 days, occasionally up to two weeks.
- [ ] After approval, note the **Team ID** (10 characters, Membership page).
- [ ] Create a **Developer ID Application** certificate (Xcode →
      Settings → Accounts → Manage Certificates, or the developer portal).
      Export as `.p12` with a strong password.
- [ ] Create an **App Store Connect API key** for `notarytool`
      (Users & Access → Integrations): record Issuer ID, Key ID, download the
      `.p8` once.
- [ ] When Phase 6 arrives, add GitHub repo secrets and uncomment the slots in
      `.github/workflows/build.yml`:
      `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`,
      `APPLE_SIGNING_IDENTITY` ("Developer ID Application: Name (TEAMID)"),
      `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`.

## B. Windows — signing provider decision

**Verified July 2026:** Azure Trusted Signing has been renamed **Azure Artifact
Signing**. Per Microsoft's FAQ, Public Trust onboarding is limited to
**organizations in USA/Canada/EU/UK and individuals in USA/Canada only**, needs
a **paid** Azure subscription (Basic tier ≈ $9.99/mo), and identity validation
(government photo ID + Verified ID selfie) takes anywhere from ~1 hour to
~10 days, cannot be expedited, and **expires periodically**.

- [ ] Check current individual-eligibility regions at signup time — the list
      has been expanding since the 2024 preview.
      Re-check date: ______
- [ ] If eligible: create the Artifact Signing account + Identity Validation +
      **Public Trust certificate profile**; wire CI via an Entra service
      principal (`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`)
      and `bundle.windows.signCommand` in `tauri.conf.json`
      (e.g. `trusted-signing-cli`).
- [ ] If not eligible, evaluate (decision needed by Phase 6, not now):
  - **Certum Open Source Code Signing** — individual-friendly, ≈ €70–100/yr,
    cloud signing or smart card.
  - **SSL.com eSigner** (OV) — cloud signing, CI-friendly, pricier.
  - **Ship unsigned through beta** — document the SmartScreen warning honestly
    in the README/downloads page; revisit before 1.0.

## C. Linux

No signing authority needed for AppImage/deb/rpm in Phase 0–5. Phase 6 adds:
repo GPG key for deb/rpm repositories (generate and back up offline), AUR
account, Flathub submission (the `io.github.fllaa.tern` identifier is already
in the sanctioned form).

## D. Tauri updater key (Phase 6, note now)

The auto-updater needs a **minisign keypair** (`bun tauri signer generate`).
Generate it when the updater lands; store the private key in a password
manager + as a CI secret (`TAURI_SIGNING_PRIVATE_KEY`). Losing it strands
existing installs on manual updates — treat it like a production credential.
