# Jupiter Arch Packaging

This directory contains the `jupiter-bin` Arch/AUR package template.

## Release package

The desktop release workflow renders `PKGBUILD.in` with the release `.deb`
checksum, builds a native `.pkg.tar.zst` package in an Arch Linux container,
and uploads it to the GitHub Release.

Local build example:

```bash
scripts/build-arch-package.sh \
  --tag desktop-v1.0.1 \
  --deb dist/release-assets/Jupiter_desktop-v1.0.1_linux-x64.deb
```

## AUR publishing

AUR stores the package recipe, not binary packages. For `jupiter-bin`, render a
release PKGBUILD with both architecture URLs and checksums, then generate
`.SRCINFO` before pushing to `ssh://aur@aur.archlinux.org/jupiter-bin.git`.

```bash
node scripts/render-arch-pkgbuild.mjs \
  --tag desktop-v1.0.1 \
  --x64-url https://github.com/nighty35628/Jupiter/releases/download/desktop-v1.0.1/Jupiter_desktop-v1.0.1_linux-x64.deb \
  --x64-sha256 <linux-x64-deb-sha256> \
  --arm64-url https://github.com/nighty35628/Jupiter/releases/download/desktop-v1.0.1/Jupiter_desktop-v1.0.1_linux-arm64.deb \
  --arm64-sha256 <linux-arm64-deb-sha256> \
  --out PKGBUILD

makepkg --printsrcinfo > .SRCINFO
```
