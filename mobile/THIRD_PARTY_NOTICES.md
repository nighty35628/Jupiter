# Android Third-Party Inventory and Outstanding Distribution Work

Scope: the current ARM64 Android QA recipe, inspected on 2026-11-01. This file
supplements the repository's [existing notices](../THIRD_PARTY_NOTICES.md) and
[license](../LICENSE); it does not replace upstream license texts. Component
licenses remain with their authors. Neither successful packaging nor this document
establishes full redistribution compliance. No corresponding-source release bundle
or fulfilled source offer is supplied by these three mobile documentation/build files.

## Ubuntu Userspace and Toolset

The base is `ubuntu-base-24.04.5-base-arm64.tar.gz`, pinned by URL and SHA-256 in
`runtime-lock.json`. Additional packages come from the Ubuntu noble/noble-updates/
noble-security snapshot `20261030T000000Z`, using `mobile/rootfs/ubuntu.sources`.
The build-only Ubuntu cloud VM image is separately pinned in
`build-environment-lock.json`; it is not the rootfs archive embedded in the APK.

Ubuntu is a distribution, not one blanket software license. The current local
`toolset/packages.tsv` lists 130 binary package/version/architecture entries.
Use each installed package's `/usr/share/doc/<package>/copyright` and
`/usr/share/common-licenses/*` in `rootfs-tools.tar.gz` / `rootfs.tar.gz` as the
file-level license inventory. These trees retain such records; preserve them when
redistributing. Do not classify all 130 packages by the four requested tool names.

Examples from the inspected package metadata (not an exhaustive SBOM):

| Component | License scope |
| --- | --- |
| Bash/coreutils and other GNU programs | GPL terms per package/file, including GPL-3.0-or-later components |
| Git 2.43.0 Ubuntu package | Predominantly GPL-2.0, with additional BSD/Zlib/LGPL and other file-specific notices |
| glibc (`libc6`) | Predominantly LGPL-2.1-or-later; retain additional file notices |
| Python 3.12 | Python/PSF license history and incorporated third-party terms in its package copyright file |
| ripgrep 14.1.0 | Main code Unlicense or MIT; package includes additional BSD-3-Clause file notices |
| CA certificates and linked libraries | Mixed certificate-data/library licenses; inspect the corresponding package records |

**Still required for distribution:** map every relevant binary package to its exact
Ubuntu source package/version and provide its corresponding source as required by
that component's license. Include applicable `.dsc`, original upstream archive(s),
Debian/Ubuntu changes/patches and build/install scripts, or implement a valid
license-specific source-delivery alternative. A binary `.deb` cache,
`packages.tsv`, signed binary indexes, download hashes, or a general Ubuntu homepage
is not corresponding source or a fulfilled written offer. The current apt recipe
uses `Types: deb`, not source retrieval. Preserve the recipe and any local changes
alongside the required source. Assess LGPL replacement/relinking obligations where
combined works are conveyed, rather than treating a shared-object filename as proof.

Ubuntu/Canonical marks are separate from software copyright permissions. This is
not an endorsed Ubuntu product; consult the official
[Canonical intellectual-property policy](https://canonical.com/legal/intellectual-property-policy).

## Node.js 22.23.4

Input: `node-v22.23.4-linux-arm64.tar.xz`, pinned in `runtime-lock.json`.
Source: [Node v22.23.4](https://github.com/nodejs/node/tree/v22.23.4).
Node's core uses MIT terms, but the binary includes independently licensed
dependencies. Its complete [versioned LICENSE](https://raw.githubusercontent.com/nodejs/node/v22.23.4/LICENSE)
contains the bundled dependency notices; do not replace it with just an MIT label.
The inspected rootfs archive retains that text at `/usr/local/LICENSE` after extraction.
Preserve it and review the dependency-specific terms for the exact shipped binary.

## PRoot, Loader and Android Support Libraries

| Shipped name | Locked package | Upstream and license evidence |
| --- | --- | --- |
| `libproot.so`, `libproot-loader.so` | Termux `proot_5.1.107.101_aarch64.deb` | [Termux recipe](https://github.com/termux/termux-packages/blob/master/packages/proot/build.sh), [versioned source](https://github.com/termux/proot/tree/v5.1.107.101), [COPYING](https://github.com/termux/proot/blob/v5.1.107.101/COPYING). Recipe labels GPL-2.0; source headers grant GPL-2.0-or-later. |
| `libtalloc.so` | Termux `libtalloc_2.5.0_aarch64.deb` | [Termux recipe](https://github.com/termux/termux-packages/blob/master/packages/libtalloc/build.sh) labels GPL-3.0. The [talloc 2.5.0 library header](https://github.com/samba-team/samba/blob/talloc-2.5.0/lib/talloc/talloc.c) grants LGPL-3.0-or-later. This distinction is unresolved for all linked/package content, not a blanket LGPL clearance. |
| `libandroid-shmem.so` | Termux `libandroid-shmem_0.7_aarch64.deb` | [v0.7 source/license](https://github.com/termux/libandroid-shmem/blob/v0.7/LICENSE), BSD-3-Clause; copyrights Sergii Pylypenko (2013), Fredrik Fornwall (2017). |

Termux recipe `master` links are discovery references, not immutable provenance for
the already downloaded `.deb` files. Archive the actual matching Termux recipe
revision, patches and toolchain/build configuration with the release records.

Local changes in `prepare-runtime.mjs`: the executable/loader are renamed for
Android native extraction; the PRoot dependency string and talloc SONAME are patched
in place from `libtalloc.so.2` to `libtalloc.so`. Original hashes and patch descriptions
are in `runtime-manifest.json`. Do not describe these files as unmodified upstream
binaries. Keep dated modification notices and the patch/build script with source.

**Outstanding PRoot/talloc obligations:** ship applicable GPL/LGPL texts and notices
with the distribution, and arrange complete corresponding source for the actual
modified binaries, including Termux patches, local modifications, loader and
build/install controls. For GPLv2 distribution, choose an applicable section 3
source-delivery route; an arbitrary upstream link is not automatically enough.
For LGPLv3 library/combined-work distribution, review GPLv3/LGPLv3 source delivery,
replacement/relinking and applicable installation-information requirements. Verify
compatible terms for the PRoot/talloc combination; do not infer incompatibility
from a package-level GPL-2.0 shorthand when source grants later-version choice.
These source/offer and linked-content reviews are not completed here.

**Outstanding shmem notice:** the preparation script copies the `.so` only, not its
Termux `share/doc/libandroid-shmem/copyright`. Deliver the complete BSD copyright,
three conditions and disclaimer with the APK/documentation. This table and a URL
alone do not reproduce that required notice.

## PTY Addon and Header Dependencies

`node-pty` 1.1.0 is [Microsoft's MIT-licensed project](https://github.com/microsoft/node-pty/tree/1.1.0).
The Android recipe compiles its local `src/unix/pty.cc` into a Linux ARM64
`pty.node`; it does not ship the host's macOS addon. The manifest records source,
header-input and binary hashes plus compiler arguments. The packager copies
`node-pty/LICENSE` into the engine, retaining Christopher Jeffrey, Daniel Imms
and Microsoft notices.

Two additional notice checks are specifically still open:

- `node_modules/node-pty/src/unix/pty.cc` contains tmux-derived code with an
  ISC-style notice naming Nicholas Marriott, Joshua Elsasser and Todd Carson
  (2009). The inspected top-level MIT `LICENSE` does not reproduce that notice;
  retain its complete copyright/permission/disclaimer text for the compiled code.
- `node-addon-api` headers are used in compilation and carry the MIT notice for
  Node.js API collaborators (2017), at local `node_modules/node-addon-api/LICENSE.md`.
  The engine packager does not explicitly copy that separate header notice;
  provide it for incorporated header code. Node headers also need the matching
  Node license/dependency notice review above.

Zig and the Linux build VM are preparation tools, not automatically shipped app
components. If their files/runtime support are redistributed or statically included,
audit those actual contents too; a compiler argument list is not a linked-object SBOM.

## Photon Image Runtime and Dependencies

`@silvia-odwyer/photon-node` 0.3.4 declares Apache-2.0 and is copied, including
`LICENSE.md`, JS glue and `photon_rs_bg.wasm`, into
`engine/dist/node_modules/@silvia-odwyer/photon-node/` by the root build's
`scripts/copy-image-runtime.mjs`. The image-size 2.0.2 package is MIT and is copied
alongside it with its package files. This is local image processing, not an image API.

The npm Photon package is not a complete Rust dependency-license manifest. The
public [upstream Cargo manifest](https://github.com/silvia-odwyer/photon/blob/master/crate/Cargo.toml)
currently identifies crate 0.3.3 and lists image, imageproc, palette, rand, rusttype,
base64, time, serde, thiserror, wasm-bindgen and related dependencies. **That moving
manifest is not proof of the exact dependency graph compiled into npm 0.3.4's WASM.**
Similarly, [upstream text rendering](https://github.com/silvia-odwyer/photon/blob/master/crate/src/text.rs)
embeds `Roboto-Regular.ttf`; confirm whether that asset is in the shipped WASM and
preserve its actual version-specific font notice/license if so. Do not assume all
embedded code/assets inherit Photon's Apache license.

**Still missing:** artifact-matched Photon source revision, Cargo.lock/build
features, a Rust/WASM dependency and embedded-asset inventory, and the required
license/copyright/attribution texts for those incorporated dependencies/assets.
The copied npm `LICENSE.md` alone does not establish these. Under
[Apache-2.0 section 4](https://www.apache.org/licenses/LICENSE-2.0), preserve the
license, applicable attribution and any upstream NOTICE material, plus modification
notices when applicable. There is no general Apache source-publication requirement;
the missing source/build mapping here is evidence needed to identify additional
embedded obligations, not a claim that Apache itself mandates a source bundle.

## Other Bundled Dependencies and Release Gaps

The engine also copies MIT `web-tree-sitter`, and the root JS/UI bundles incorporate
additional npm packages, grammars, fonts and assets from the repository lockfiles.
The Android app declares AndroidX WebKit/Core and transitive Android libraries;
test libraries are not automatically runtime-shipped components. Resolve the actual
release runtime dependency graph before making a complete notice inventory. Retain
the root Jupiter/DeepSeek-Reasonix notices, not just the image-runtime subsection.

Concrete distribution work not performed by `build-app.mjs`:

1. Collect exact Ubuntu and modified Termux corresponding-source materials and
   implement/document the applicable delivery route (including a valid offer only
   if that license/route is actually chosen). No signed source offer is created here.
2. Deliver PRoot/talloc GPL/LGPL license texts and dated local patch notices;
   resolve talloc package/file license scope and linked/replacement requirements.
3. Deliver shmem's full BSD-3-Clause notice, node-addon-api's MIT notice and the
   tmux-derived PTY notice, not only names and links.
4. Resolve Photon WASM dependencies/embedded font provenance and deliver their
   required texts. Audit remaining runtime JS/AndroidX/grammar/font dependencies.
5. Make the assembled notice set available to APK recipients. These Markdown files
   are repository documents; the current scoped work does not wire them into APK
   assets or an in-app notice viewer. Preserved rootfs notices remain present but
   are not a substitute for omitted native/engine notices or source provision.

The successful-build receipt intentionally says `legalReleaseApproved: false`.
It certifies neither notice completeness nor source availability. Do not distribute
under a claim of full license compliance until the above component-specific work
and the actual release artifacts have been reviewed.
