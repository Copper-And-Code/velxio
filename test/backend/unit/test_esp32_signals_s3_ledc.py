"""The ESP32-S3's (and the C3's) LEDC in the ESP32's unified channel / signal space.

The S3 has 8 low-speed channels only (LEDC_LS_SIG_OUT0..7_IDX = 73..80) and
QEMU numbers them 0-7; the frontend resolves a `ledc_duty` channel to a pin
through `ledcSignalForChannel` (ESP32 ids). The worker translates, so a duty
on the S3's channel n and the routing of its signal 73 + n meet on the same
unified id. Imports the real production module.
"""

from __future__ import annotations

from app.services.esp32_signals import (
    SIG_LEDC_HS_CH0_OUT_IDX,
    SIG_LEDC_LS_CH_LAST,
    ledc_channel_count,
    ledc_signal_for_channel,
    ledc_translation,
)


def test_s3_channel_and_signal_meet_in_the_unified_space():
    channel_out, signal_out = ledc_translation('esp32s3-picsimlab')
    for n in range(8):
        assert ledc_signal_for_channel(channel_out(n)) == signal_out(73 + n)


def test_s3_signals_outside_its_ledc_are_not_ledc():
    _, signal_out = ledc_translation('esp32s3-picsimlab')
    assert signal_out(72) is None
    assert signal_out(81) is None   # RMT_SIG_OUT0_IDX on the S3
    assert signal_out(71) is None   # an ESP32 HS id means nothing on the S3


def test_esp32_is_unchanged():
    channel_out, signal_out = ledc_translation('esp32-picsimlab')
    assert [channel_out(c) for c in range(16)] == list(range(16))
    for sig in range(256):
        expected = sig if SIG_LEDC_HS_CH0_OUT_IDX <= sig <= SIG_LEDC_LS_CH_LAST else None
        assert signal_out(sig) == expected


def test_c3_channel_and_signal_meet_in_the_unified_space():
    channel_out, signal_out = ledc_translation('esp32c3-picsimlab')
    for n in range(6):
        assert ledc_signal_for_channel(channel_out(n)) == signal_out(45 + n)
    assert signal_out(51) is None   # RMT_SIG_OUT0_IDX on the C3


def test_duty_table_sizes():
    assert ledc_channel_count('esp32-picsimlab') == 16
    assert ledc_channel_count('esp32s3-picsimlab') == 8
    assert ledc_channel_count('esp32c3-picsimlab') == 6
