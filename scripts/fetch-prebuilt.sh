#!/usr/bin/env bash
# Download the binaries this fork runs but does not keep in git: the QEMU
# builds (ESP32 libraries and ROMs, the RP2350 qemu-system-arm) and the
# VELXIO firmwares of the panel boards. Each one is a release asset of the
# public repository it is built from, pinned with its SHA-256 in
# scripts/prebuilt.lock.
#
#   scripts/fetch-prebuilt.sh            fetch what is missing or changed
#   scripts/fetch-prebuilt.sh --force    fetch everything again
#
# Run it before `npm run dev` / the backend, or before `docker build`
# (Dockerfile.standalone copies prebuilt/ into the image). Linux x86_64.
set -euo pipefail

ROOT=${PREBUILT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
LOCK=${PREBUILT_LOCK:-$(cd "$(dirname "$0")" && pwd)/prebuilt.lock}
FORCE=0
[[ ${1:-} == --force ]] && FORCE=1

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null || die "curl is needed"
command -v sha256sum >/dev/null || die "sha256sum is needed"
[[ $(uname -sm) == "Linux x86_64" ]] || echo "warning: the QEMU builds are for Linux x86_64, this is $(uname -sm)" >&2

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A stamp per entry: the SHA-256 it was fetched with.
STAMPS=$ROOT/prebuilt/.fetched
mkdir -p "$STAMPS"

n=0
while read -r kind url sha dest; do
    [[ -z $kind || $kind == \#* ]] && continue
    n=$((n + 1))
    stamp=$STAMPS/$(printf '%s' "$dest $(basename "$url")" | sha256sum | cut -c1-16)
    if [[ $FORCE == 0 && -f $stamp && $(cat "$stamp") == "$sha" ]]; then
        echo "ok      $(basename "$url")"
        continue
    fi
    echo "fetch   $url"
    file=$TMP/$(basename "$url")
    curl -fsSL --retry 3 -o "$file" "$url" || die "download failed: $url"
    echo "$sha  $file" | sha256sum -c --quiet - || die "SHA-256 mismatch: $url"
    case $kind in
        tar)
            # An archive with one top directory: its files go into dest; its
            # SOURCE.txt is kept per archive, named after it.
            mkdir -p "$ROOT/$dest" "$TMP/x"
            rm -rf "$TMP/x"/*
            tar -xzf "$file" -C "$TMP/x"
            top=$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -1)
            [[ -n $top ]] || die "no directory in $(basename "$url")"
            [[ -f $top/SOURCE.txt ]] && mv "$top/SOURCE.txt" "$top/SOURCE-$(basename "$top").txt"
            cp -a "$top"/. "$ROOT/$dest/"
            ;;
        file)
            mkdir -p "$(dirname "$ROOT/$dest")"
            cp "$file" "$ROOT/$dest"
            ;;
        *) die "unknown kind '$kind' in $LOCK" ;;
    esac
    echo "$sha" > "$stamp"
    echo "        -> $dest"
done < "$LOCK"

[[ $n -gt 0 ]] || die "nothing listed in $LOCK"
echo "done"
