#!/usr/bin/env bash
set -euo pipefail

REPO="${JUPITER_REPO:-nighty35628/Jupiter}"
VERSION="${JUPITER_VERSION:-latest}"

usage() {
  cat <<'EOF'
Install Jupiter Desktop on Linux from GitHub Releases.

Usage:
  ./install-linux.sh [--version desktop-vX.Y.Z] [--repo owner/repo]

Environment:
  JUPITER_REPO      GitHub repo to download from. Default: nighty35628/Jupiter
  JUPITER_VERSION   Release tag or "latest". Default: latest

Notes:
  Debian/Ubuntu family installs the .deb with apt/dpkg.
  Arch/Manjaro/EndeavourOS extracts the same .deb into / using sudo.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:?missing value for --repo}"
      shift 2
      ;;
    --version)
      VERSION="${2:?missing value for --version}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

normalize_tag() {
  case "$VERSION" in
    latest) printf '%s' "$VERSION" ;;
    desktop-v*) printf '%s' "$VERSION" ;;
    v*) printf 'desktop-%s' "$VERSION" ;;
    *) printf 'desktop-v%s' "$VERSION" ;;
  esac
}

release_api_url() {
  local tag
  tag="$(normalize_tag)"
  if [ "$tag" = "latest" ]; then
    printf 'https://api.github.com/repos/%s/releases/latest' "$REPO"
  else
    printf 'https://api.github.com/repos/%s/releases/tags/%s' "$REPO" "$tag"
  fi
}

deb_arch_regex() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' '(amd64|x86_64|x64)' ;;
    aarch64|arm64) printf '%s\n' '(arm64|aarch64)' ;;
    *)
      echo "Unsupported CPU architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

download_deb() {
  need awk
  need curl
  local tmp json_url asset_url deb arch_re
  tmp="$(mktemp -d)"
  json_url="$(release_api_url)"
  arch_re="$(deb_arch_regex)"

  echo "Fetching release metadata: $json_url" >&2
  asset_url="$(
    curl -fsSL \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "$json_url" |
      awk -v arch_re="$arch_re" '
        /"browser_download_url": ".*\.deb"/ {
          url = $0
          sub(/^.*"browser_download_url": "/, "", url)
          sub(/".*$/, "", url)
          if (url ~ arch_re) {
            print url
            exit
          }
        }
      ' ||
      true
  )"

  if [ -z "$asset_url" ]; then
    echo "No $(uname -m) .deb asset found in release metadata for $REPO ($VERSION)." >&2
    echo "Open: https://github.com/$REPO/releases" >&2
    exit 1
  fi

  deb="$tmp/jupiter.deb"
  echo "Downloading: $asset_url" >&2
  curl -fL --progress-bar "$asset_url" -o "$deb"
  printf '%s\n' "$deb"
}

install_debian_deb() {
  local deb="$1"
  if command -v apt-get >/dev/null 2>&1; then
    sudo_cmd apt-get install -y "$deb"
    return
  fi
  need dpkg
  sudo_cmd dpkg -i "$deb" || sudo_cmd apt-get -f install -y
}

install_arch_from_deb() {
  local deb="$1"
  local work data
  if { ! command -v ar >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; } &&
    command -v pacman >/dev/null 2>&1; then
    sudo_cmd pacman -Sy --needed --noconfirm binutils tar
  fi
  need ar
  need tar
  work="$(mktemp -d)"
  (
    cd "$work"
    ar x "$deb"
    data="$(ls data.tar.* 2>/dev/null | head -n 1)"
    if [ -z "$data" ]; then
      echo "Could not find data.tar.* inside $deb" >&2
      exit 1
    fi
    echo "Extracting Debian payload into / for Arch-family system."
    sudo_cmd tar -C / -xf "$data"
  )
  rm -rf "$work"
}

detect_linux_family() {
  local id like
  id=""
  like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    id="${ID:-}"
    like="${ID_LIKE:-}"
  fi
  printf '%s %s\n' "$id" "$like" | tr '[:upper:]' '[:lower:]'
}

main() {
  local family deb
  family="$(detect_linux_family)"
  deb="$(download_deb)"

  case "$family" in
    *debian*|*ubuntu*|*linuxmint*|*pop*)
      install_debian_deb "$deb"
      ;;
    *arch*|*endeavouros*|*manjaro*)
      install_arch_from_deb "$deb"
      ;;
    *)
      if command -v dpkg >/dev/null 2>&1; then
        install_debian_deb "$deb"
      elif command -v pacman >/dev/null 2>&1; then
        install_arch_from_deb "$deb"
      else
        echo "Unsupported Linux distribution. Download manually from:" >&2
        echo "https://github.com/$REPO/releases" >&2
        exit 1
      fi
      ;;
  esac

  echo "Jupiter Desktop installed."
}

main "$@"
