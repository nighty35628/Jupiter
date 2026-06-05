# Jupiter Desktop — code signing & notarization

Walkthrough for shipping a signed Jupiter Desktop bundle.

The release workflow at `.github/workflows/release.yml` reads signing
material from repository **Secrets** when optional signing is enabled —
nothing in this repo holds keys. Without these secrets set the workflow
still builds, but installers come out unsigned for Windows/Linux/macOS.
Unsigned Windows NSIS installers may trigger Microsoft Defender
SmartScreen warnings. Unsigned macOS builds may be marked "damaged" until
the quarantine attribute is removed.

## Tauri updater signing (all platforms)

Tauri's updater verifies bundle artifacts against a public key embedded
in the app. Generate once and commit the **public** half to
`tauri.conf.json`.

```bash
cd desktop
npx @tauri-apps/cli signer generate -w ~/.tauri/jupiter.key
```

Outputs:
- `~/.tauri/jupiter.key` — the **private** key. Never commit. Add a
  passphrase when prompted.
- `~/.tauri/jupiter.key.pub` — paste into `tauri.conf.json` under
  `plugins.updater.pubkey`, replacing `REPLACE_ME_RUN_tauri_signer_generate`.

Set repo secrets:
- `TAURI_SIGNING_PRIVATE_KEY` — full contents of `~/.tauri/jupiter.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase

The workflow exports both as env vars; `tauri-action` picks them up and
signs the per-platform update bundle (`*.tar.gz.sig`, `*.zip.sig`,
`*.msi.zip.sig`, …) automatically.

## Windows — optional Authenticode

You need a **code signing certificate** from a CA Microsoft trusts
(DigiCert, Sectigo, SSL.com, …). EV certs avoid SmartScreen reputation
ramp; OV certs work but warn until enough installs build trust.

Jupiter currently publishes unsigned Windows installers. Users should
download only from the official GitHub Releases page and use
**More info** -> **Run anyway** if SmartScreen blocks the installer.
This keeps release packaging simple until a certificate is available.

### One-time: export the cert as PFX

The CA either ships a `.pfx` directly or a `.cer` + private key. If you
get the latter, combine with `openssl`:

```bash
openssl pkcs12 -export \
  -inkey jupiter.key \
  -in jupiter.cer \
  -out jupiter.pfx \
  -name "Jupiter Code Signing"
```

Set a strong export password — needed below.

### Wire into a signed release workflow

A future signed Windows workflow should read these secrets:

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | base64-encoded contents of `jupiter.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the PFX export password |

Encode the cert before adding the secret:

```bash
base64 -w0 jupiter.pfx > jupiter.pfx.b64
```

The current workflow does not require these secrets. If signing is added
later, import the PFX into the current-user certificate store, sign the
bundled `node.exe` before packaging, let `tauri-action` sign the app and
NSIS installer, then verify all Windows binaries with `signtool`. EV
certificates are preferable because they carry stronger initial
reputation.

### Verify locally before pushing the tag

```powershell
signtool verify /pa /v Jupiter_0.40.0_x64-setup.exe
```

Output should include `Successfully verified` and the certificate's
common name.

## macOS — Developer ID + notarization

Two separate signatures are required for a non-warning install:

1. **Code signing** with a Developer ID Application certificate — proves
   the bundle came from a paid Apple Developer account.
2. **Notarization** — Apple's automated malware scan, returns a ticket
   that gets stapled into the `.dmg` / `.app`.

### One-time: certificate

Enroll in the [Apple Developer Program] ($99/yr). In Xcode → Settings →
Accounts → Manage Certificates, create a `Developer ID Application`
cert. Export from Keychain as a `.p12` with a passphrase.

```bash
base64 -i JupiterDeveloperID.p12 -o cert.p12.b64
```

### One-time: app-specific password for notarytool

Notarization uses the Apple ID, not the cert. At
<https://appleid.apple.com> → Sign-In and Security → App-Specific
Passwords, generate one labelled "jupiter notarytool". Save it — Apple
only shows it once.

### Repository secrets

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` passphrase |
| `APPLE_SIGNING_IDENTITY` | the Common Name, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password from the previous step |
| `APPLE_TEAM_ID` | 10-character team identifier, visible in Apple Developer → Membership |

The release workflow already passes all six to `tauri-action`. Once
they're set, builds for both `macos-13` (Intel) and `macos-14` (Apple
Silicon) produce a signed + notarized `.dmg`.

### Verify locally

After downloading the artifact:

```bash
spctl -a -t open --context context:primary-signature -vvv Jupiter_0.40.0_aarch64.dmg
# expected: source=Notarized Developer ID
```

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Jupiter.app
# expected: valid on disk + satisfies its Designated Requirement
```

[Apple Developer Program]: https://developer.apple.com/programs/

### Unsigned macOS workaround

If a test build is not signed/notarized and macOS says the app is
damaged or cannot be opened, move it into `/Applications` and remove the
quarantine flag:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## Linux

No signing required — `.deb` and `.AppImage` ship plain. If the project
ever publishes a Flatpak or Snap, the respective store handles signing
on upload.

## Updater pubkey rotation

Rotating the updater key invalidates every previously installed
client's ability to verify updates. Avoid unless the private key
leaked. If it must happen:

1. Generate a new key pair (`tauri signer generate`).
2. Ship one transitional release signed with the **old** key whose
   notes tell users to download fresh installers manually.
3. Replace `tauri.conf.json#plugins.updater.pubkey` in the next release.
4. Update `TAURI_SIGNING_PRIVATE_KEY` in repo secrets.

## Troubleshooting

- **"errSecInternalComponent" on macOS runners** — Apple's `notarytool`
  needs the keychain unlocked. `tauri-action` handles this when the six
  Apple secrets are present; if you've inlined custom steps, add a
  keychain-unlock step before signing.
- **"The signature of the application is invalid"** on Windows after
  an update — almost always means the updater's `pubkey` in
  `tauri.conf.json` doesn't match the private key used by the workflow.
  Confirm both halves come from the same `signer generate` run.
- **`xcrun: error: unable to find utility "altool"`** — runner is on
  Xcode older than 13. Pin `xcode-select` or upgrade the runner image;
  `notarytool` (the replacement) is what Tauri v2 uses.
