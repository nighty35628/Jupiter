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
  Arch/Manjaro/EndeavourOS installs the native .pkg.tar.zst with pacman
  when that release asset is available. Older releases fall back to extracting
  the .deb payload into / and refreshing desktop/icon caches when possible.
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

need_privilege_escalation() {
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    echo "This installer needs root privileges. Re-run as root or install sudo." >&2
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

linux_arch_regex() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' '(amd64|x86_64|x64)' ;;
    aarch64|arm64) printf '%s\n' '(arm64|aarch64)' ;;
    *)
      echo "Unsupported CPU architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

download_release_asset() {
  need awk
  need curl
  local asset_re="$1"
  local output_name="$2"
  local required="${3:-required}"
  local tmp json_url asset_url output
  tmp="$(mktemp -d)"
  json_url="$(release_api_url)"

  echo "Fetching release metadata: $json_url" >&2
  asset_url="$(
    curl -fsSL \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "$json_url" |
      awk -v asset_re="$asset_re" '
        /"browser_download_url": "/ {
          url = $0
          sub(/^.*"browser_download_url": "/, "", url)
          sub(/".*$/, "", url)
          if (url ~ asset_re) {
            print url
            exit
          }
        }
      ' ||
      true
  )"

  if [ -z "$asset_url" ]; then
    if [ "$required" = "optional" ]; then
      return 1
    fi
    echo "No matching release asset found for $(uname -m) in $REPO ($VERSION)." >&2
    echo "Open: https://github.com/$REPO/releases" >&2
    exit 1
  fi

  output="$tmp/$output_name"
  echo "Downloading: $asset_url" >&2
  curl -fL --progress-bar "$asset_url" -o "$output"
  printf '%s\n' "$output"
}

download_deb() {
  local arch_re
  arch_re="$(linux_arch_regex)"
  download_release_asset "(${arch_re}).*\\.deb$" "jupiter.deb" "required"
}

download_pacman_pkg() {
  local arch_re
  arch_re="$(linux_arch_regex)"
  download_release_asset "(${arch_re}).*\\.pkg\\.tar\\.zst$" "jupiter.pkg.tar.zst" "optional"
}

install_debian_deb() {
  local deb="$1"
  need_privilege_escalation
  if command -v apt-get >/dev/null 2>&1; then
    sudo_cmd apt-get install -y "$deb"
    return
  fi
  need dpkg
  sudo_cmd dpkg -i "$deb" || sudo_cmd apt-get -f install -y
}

install_arch_pacman_pkg() {
  local pkg="$1"
  need_privilege_escalation
  need pacman
  install_arch_runtime_deps
  remove_unmanaged_arch_install
  sudo_cmd pacman -U --needed --noconfirm "$pkg"
}

install_arch_runtime_deps() {
  need_privilege_escalation
  need pacman
  echo "Installing Arch runtime dependencies: gtk3 webkit2gtk-4.1 libayatana-appindicator librsvg openssl hicolor-icon-theme" >&2
  sudo_cmd pacman -S --needed --noconfirm \
    gtk3 \
    webkit2gtk-4.1 \
    libayatana-appindicator \
    librsvg \
    openssl \
    hicolor-icon-theme
}

remove_unmanaged_path() {
  local path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return
  fi
  if pacman -Qo "$path" >/dev/null 2>&1; then
    return
  fi
  echo "Removing unmanaged old Jupiter install path before pacman install: $path" >&2
  sudo_cmd rm -rf "$path"
}

remove_unmanaged_arch_install() {
  local icon
  remove_unmanaged_path /usr/bin/Jupiter
  remove_unmanaged_path /usr/lib/Jupiter
  remove_unmanaged_path /usr/share/applications/Jupiter.desktop
  if [ -d /usr/share/icons/hicolor ]; then
    while IFS= read -r icon; do
      remove_unmanaged_path "$icon"
    done < <(
      find /usr/share/icons/hicolor \
        \( -path '*/apps/Jupiter.png' -o -path '*/apps/jupiter.png' \) \
        -print 2>/dev/null
    )
  fi
}

install_arch_extraction_deps() {
  local missing=()
  for cmd in ar tar gzip xz zstd; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    return
  fi
  if ! command -v pacman >/dev/null 2>&1; then
    echo "Missing required command(s): ${missing[*]}" >&2
    exit 1
  fi
  echo "Installing Arch extraction dependencies: binutils tar gzip xz zstd" >&2
  sudo_cmd pacman -S --needed --noconfirm binutils tar gzip xz zstd
}

refresh_desktop_caches() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    sudo_cmd update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    sudo_cmd gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
  fi
}

install_arch_from_deb() {
  local deb="$1"
  local work data
  need_privilege_escalation
  install_arch_runtime_deps
  install_arch_extraction_deps
  work="$(mktemp -d)"
  (
    cd "$work"
    ar x "$deb"
    data="$(ls data.tar.* 2>/dev/null | head -n 1)"
    if [ -z "$data" ]; then
      echo "Could not find data.tar.* inside $deb" >&2
      exit 1
    fi
    echo "Extracting Debian payload into / for Arch-family system." >&2
    sudo_cmd tar -C / -xf "$data"
  )
  rm -rf "$work"
  refresh_desktop_caches
  echo "Installed from Debian payload. Note: pacman will not track files installed through this convenience path." >&2
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
  local family deb pkg
  family="$(detect_linux_family)"

  case "$family" in
    *debian*|*ubuntu*|*linuxmint*|*pop*)
      deb="$(download_deb)"
      install_debian_deb "$deb"
      ;;
    *arch*|*endeavouros*|*manjaro*)
      if pkg="$(download_pacman_pkg)"; then
        install_arch_pacman_pkg "$pkg"
      else
        echo "No native pacman package found for this release; falling back to .deb payload extraction." >&2
        deb="$(download_deb)"
        install_arch_from_deb "$deb"
      fi
      ;;
    *)
      if command -v dpkg >/dev/null 2>&1; then
        deb="$(download_deb)"
        install_debian_deb "$deb"
      elif command -v pacman >/dev/null 2>&1; then
        if pkg="$(download_pacman_pkg)"; then
          install_arch_pacman_pkg "$pkg"
        else
          echo "No native pacman package found for this release; falling back to .deb payload extraction." >&2
          deb="$(download_deb)"
          install_arch_from_deb "$deb"
        fi
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
