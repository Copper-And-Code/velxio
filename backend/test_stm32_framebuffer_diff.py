import time

from app.services import renode_manager as rm
from app.services.renode_manager import RenodeInstance, RenodeManager


def test_diff_band_rect_packs_minimal_bpp_aligned_rect() -> None:
    width = 8
    rows = 4
    bpp = 2
    pitch = width * bpp
    old = bytearray(pitch * rows)
    new = bytearray(old)

    def put_pixel(row: int, col: int, value: int) -> None:
        off = row * pitch + col * bpp
        new[off] = value & 0xFF
        new[off + 1] = (value >> 8) & 0xFF

    put_pixel(1, 2, 0x1234)
    put_pixel(2, 4, 0x5678)

    rect = RenodeManager._diff_band_rect(bytes(old), bytes(new), 10, rows, width, pitch, bpp)

    assert rect is not None
    x, y, rect_w, rect_h, rect_pitch, payload = rect
    assert (x, y, rect_w, rect_h, rect_pitch) == (2, 11, 3, 2, 6)
    assert len(payload) == rect_pitch * rect_h
    assert payload[0:2] == bytes([0x34, 0x12])
    assert payload[rect_pitch + 4:rect_pitch + 6] == bytes([0x78, 0x56])


def test_diff_band_rect_returns_none_for_unchanged_band() -> None:
    data = bytes(8 * 2 * 4)
    rect = RenodeManager._diff_band_rect(data, data, 0, 4, 8, 16, 2)
    assert rect is None


def test_wake_framebuffer_poll_sets_fast_window_and_event() -> None:
    async def callback(_event_type: str, _data: dict) -> None:
        return None

    inst = RenodeInstance('test', callback)
    before = time.monotonic()
    RenodeManager._wake_framebuffer_poll(inst)

    assert inst._fb_wake_event.is_set()
    assert inst._fb_fast_until >= before + (rm._FB_FAST_WINDOW_MS / 1000.0) - 0.01


def test_many_rows_can_still_be_small_patch_payload() -> None:
    width = 100
    rows = 60
    bpp = 2
    pitch = width * bpp
    full_payload_bytes = width * rows * bpp
    old = bytes(pitch * rows)
    total_patch_bytes = 0

    for row in range(rows):
        new = bytearray(pitch)
        off = 10 * bpp
        new[off] = row & 0xFF
        new[off + 1] = 0x7F
        rect = RenodeManager._diff_band_rect(
            old[row * pitch:(row + 1) * pitch],
            bytes(new),
            row,
            1,
            width,
            pitch,
            bpp,
        )
        assert rect is not None
        total_patch_bytes += len(rect[-1])

    assert total_patch_bytes < full_payload_bytes // 2


if __name__ == '__main__':
    test_diff_band_rect_packs_minimal_bpp_aligned_rect()
    test_diff_band_rect_returns_none_for_unchanged_band()
    test_wake_framebuffer_poll_sets_fast_window_and_event()
    test_many_rows_can_still_be_small_patch_payload()
    print('PASS')
