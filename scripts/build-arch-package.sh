#!/usr/bin/env bash
set -euo pipefail

TAG=""
DEB=""
PACMAN_ARCH="x86_64"
ARCH_LABEL="linux-x64"
PKGREL="${JUPITER_ARCH_PKGREL:-1}"
OUT_DIR="dist/arch"

usage() {
  cat <<'EOF'
Build a native Arch Linux pacman package for Jupiter from a release .deb.

Usage:
  scripts/build-arch-package.sh --tag desktop-vX.Y.Z --deb path/to/Jupiter.deb [--out dist/arch]

Options:
  --tag TAG             Desktop release tag. Accepts desktop-vX.Y.Z, vX.Y.Z, or X.Y.Z.
  --deb PATH            Path to the release .deb for this architecture.
  --pacman-arch ARCH    Pacman architecture. Default: x86_64.
  --arch-label LABEL    Release asset label. Default: linux-x64.
  --pkgrel REL          Arch pkgrel. Default: 1.
  --out DIR             Output directory. Default: dist/arch.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?missing value for --tag}"; shift 2 ;;
    --deb) DEB="${2:?missing value for --deb}"; shift 2 ;;
    --pacman-arch) PACMAN_ARCH="${2:?missing value for --pacman-arch}"; shift 2 ;;
    --arch-label) ARCH_LABEL="${2:?missing value for --arch-label}"; shift 2 ;;
    --pkgrel) PKGREL="${2:?missing value for --pkgrel}"; shift 2 ;;
    --out) OUT_DIR="${2:?missing value for --out}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ] || [ -z "$DEB" ]; then
  usage >&2
  exit 2
fi

if [ ! -f "$DEB" ]; then
  echo "Missing .deb file: $DEB" >&2
  exit 1
fi

for cmd in node sha256sum makepkg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

case "$PACMAN_ARCH" in
  x86_64)
    url_arg="--x64-url"
    sha_arg="--x64-sha256"
    ;;
  aarch64)
    url_arg="--arm64-url"
    sha_arg="--arm64-sha256"
    ;;
  *)
    echo "Unsupported pacman arch: $PACMAN_ARCH" >&2
    exit 1
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

DEB_ABS="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"
SHA256="$(sha256sum "$DEB_ABS" | awk '{print $1}')"

node "$ROOT_DIR/scripts/render-arch-pkgbuild.mjs" \
  --tag "$TAG" \
  --pkgrel "$PKGREL" \
  "$url_arg" "file://$DEB_ABS" \
  "$sha_arg" "$SHA256" \
  --out "$BUILD_DIR/PKGBUILD"

(
  cd "$BUILD_DIR"
  makepkg --nodeps --force
)

mkdir -p "$ROOT_DIR/$OUT_DIR"
shopt -s nullglob
packages=( "$BUILD_DIR"/*.pkg.tar.zst )
if [ "${#packages[@]}" -eq 0 ]; then
  echo "makepkg did not produce a .pkg.tar.zst package" >&2
  exit 1
fi

target="$ROOT_DIR/$OUT_DIR/Jupiter_${TAG}_${ARCH_LABEL}.pkg.tar.zst"
cp "${packages[0]}" "$target"
printf '%s\n' "$target"
