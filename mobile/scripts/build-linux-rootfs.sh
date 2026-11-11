#!/bin/bash
set -euo pipefail

ROOT=/var/tmp/jupiter-android-rootfs
BASE=/work/downloads/ubuntu-base-24.04.5-base-arm64.tar.gz
test "$(uname -m)" = aarch64
test -d /work/build-recipe
printf '%s  %s\n' a91d5a93010193712d346d761372b7c9db6dfcf093893161c64ca107f05914f2 "$BASE" | sha256sum -c -
if mountpoint -q "$ROOT/dev" || mountpoint -q "$ROOT/proc"; then
  printf '%s\n' 'Previous build has live mounts; refusing to erase it' >&2
  exit 1
fi
rm -rf "$ROOT"
mkdir -p "$ROOT" /work/toolset/debs
tar -xzf "$BASE" -C "$ROOT"
install -m 0644 /work/build-recipe/ubuntu.sources "$ROOT/etc/apt/sources.list.d/ubuntu.sources"
install -m 0755 /work/build-recipe/policy-rc.d "$ROOT/usr/sbin/policy-rc.d"
install -m 0644 /work/build-recipe/99build-ca "$ROOT/etc/apt/apt.conf.d/99build-ca"
install -m 0644 /etc/ssl/certs/ca-certificates.crt "$ROOT/tmp/jupiter-build-ca.pem"
cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf"
cleanup() {
  local failed=0
  if mountpoint -q "$ROOT/proc"; then umount "$ROOT/proc" || failed=1; fi
  if mountpoint -q "$ROOT/dev"; then umount "$ROOT/dev" || failed=1; fi
  return "$failed"
}
trap cleanup EXIT
mount --bind /dev "$ROOT/dev"
mount -t proc proc "$ROOT/proc"
if [ "${1:-}" = --offline ]; then
  test -s /work/toolset/deb-sha256.txt
  sha256sum -c /work/toolset/deb-sha256.txt
  cp -a /work/toolset/signed-indexes/. "$ROOT/var/lib/apt/lists/"
  cp /work/toolset/debs/*.deb "$ROOT/var/cache/apt/archives/"
else
  chroot "$ROOT" apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update
  chroot "$ROOT" apt-get -y --no-install-recommends --download-only install git ripgrep python3 ca-certificates
  cp "$ROOT"/var/cache/apt/archives/*.deb /work/toolset/debs/
  chroot "$ROOT" apt-get --print-uris -y --reinstall --download-only --no-install-recommends install git ripgrep python3 ca-certificates > /work/toolset/package-uris.txt
  find /work/toolset/debs -type f -name '*.deb' -exec sha256sum '{}' + > /work/toolset/deb-sha256.txt
fi
# The installation itself must not fetch anything or reach the network.
unshare -n chroot "$ROOT" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get -y --no-download --no-install-recommends install git ripgrep python3 ca-certificates
chroot "$ROOT" dpkg-query -W '-f=${binary:Package}\t${Version}\t${Architecture}\n' > /work/toolset/packages.tsv
chroot "$ROOT" /bin/bash -euc 'git --version; rg --version; python3 --version; test -s /etc/ssl/certs/ca-certificates.crt'
if [ "${1:-}" != --offline ]; then
  rm -rf /work/toolset/signed-indexes
  cp -a "$ROOT/var/lib/apt/lists" /work/toolset/signed-indexes
fi
rm -f "$ROOT/usr/sbin/policy-rc.d"
rm -f "$ROOT/etc/apt/apt.conf.d/99build-ca" "$ROOT/tmp/jupiter-build-ca.pem"
rm -rf "$ROOT/var/lib/apt/lists" "$ROOT/var/cache/apt/archives"
rm -f "$ROOT/var/cache/apt/pkgcache.bin" "$ROOT/var/cache/apt/srcpkgcache.bin"
mkdir -p "$ROOT/var/lib/apt/lists" "$ROOT/var/cache/apt/archives/partial"
install -m 0644 /work/build-recipe/resolv.conf "$ROOT/etc/resolv.conf"
find "$ROOT/var/log" -type f -exec truncate -s 0 '{}' +
rm -f "$ROOT/var/cache/ldconfig/aux-cache"
cleanup
trap - EXIT
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --hard-dereference -czf /work/toolset/rootfs-tools.tar.gz.part -C "$ROOT" .
mv /work/toolset/rootfs-tools.tar.gz.part /work/toolset/rootfs-tools.tar.gz
sha256sum /work/toolset/rootfs-tools.tar.gz
