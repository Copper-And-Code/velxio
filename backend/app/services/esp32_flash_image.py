"""Helpers for ESP32 flash images shared between the in-process bridge and
the subprocess worker.

The ESP-IDF compiler in `espidf_compiler.py` builds a full 4 MB merged flash
image and then **trims the trailing 0xFF padding** before serializing the
binary into the JSON compile response (issue #101 — sending the full 4 MB
gave a ~5.5 MB base64 string that nginx / Cloudflare would buffer-fail with
"No response from server"). The frontend stores the trimmed bytes; this
module re-pads them on the receiving side just before QEMU attaches the
image as an MTD drive — QEMU rejects flash sizes that aren't a power-of-2
megabyte (2 / 4 / 8 / 16 MB).

This is a lossless round trip: bytes after `last_used` in the compiler's
merge are 0xFF by construction, so trim → pad reproduces the original
image byte-for-byte.
"""

from __future__ import annotations

import re

# Sizes QEMU's esp32-picsimlab MTD layer accepts. ESP32 / S3 / C3 builds
# all default to 4 MB (CONFIG_ESPTOOLPY_FLASHSIZE_4MB). We only ever
# round UP — never down.
_VALID_FLASH_SIZES = [s * 1024 * 1024 for s in (2, 4, 8, 16)]
_MIN_FLASH_BYTES = 4 * 1024 * 1024


def pad_to_flash_size(fw_bytes: bytes, min_bytes: int = 0) -> bytes:
    """Pad `fw_bytes` with 0xFF up to the next valid QEMU flash size, and to
    at least `min_bytes`: a board whose partition table spans a bigger flash
    (the ESP32-4848S040's 16 MB) is sent compact and grown here, since the
    whole image would not fit a WebSocket message.

    Returns the input unchanged when it's already at or above a valid size.
    Raises `ValueError` if the firmware exceeds the largest size we accept
    (16 MB) — at that point something is wrong with the upstream merge.
    """
    target = next(
        (s for s in _VALID_FLASH_SIZES if s >= max(len(fw_bytes), _MIN_FLASH_BYTES, min_bytes)),
        None,
    )
    if target is None:
        raise ValueError(
            f'ESP32 firmware too large for QEMU: {len(fw_bytes)} bytes (max 16 MB)'
        )
    if len(fw_bytes) >= target:
        return fw_bytes
    return fw_bytes + b'\xff' * (target - len(fw_bytes))


# "MicroPython v1.28.0 on 2026-04-06" in a release build; a build from a
# commit between two tags says the commit instead ("MicroPython 0fd6c573ea on
# 2026-11-26", the VELXIO firmware of the ESP32-4848S040). The build date is
# what both end with.
_MICROPYTHON_BANNER = re.compile(rb'MicroPython [0-9A-Za-z.+_-]{1,48} on 20\d\d-\d\d-\d\d')


def firmware_is_micropython(image: bytes) -> bool:
    """True when a flash image carries a MicroPython app.

    The REPL banner ("MicroPython v1.28.0 on 2026-04-06; ...") is a string
    literal in every build's .rodata, so its start is the signature. The
    `esp_app_desc_t` every ESP-IDF app carries would be the principled place
    to look, but MicroPython builds leave its `version` and `project_name`
    fields all zeros (checked against ESP32_GENERIC v1.28.0: only `time`,
    `date` and `idf_ver` are filled in), so it says nothing there.
    """
    return _MICROPYTHON_BANNER.search(image) is not None
