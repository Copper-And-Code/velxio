"""
Velxio STM32H7 + LVGL touch demo (runnable).

Builds a tiny LVGL UI (centered button + slider) on the 1024x600 LTDC
display, and wires the browser canvas mouse events to LVGL via the
Velxio touch mailbox at 0xC1F00000 (see docs/STM32H7_MANUAL_TEST.md
section 8 for the full architecture).

Usage:
  1. Start the Velxio backend + frontend.
  2. Click "Run" on the STM32H7 board in the browser; wait for REPL.
  3. From the host:
       mpremote connect /tmp/velxio-stm32-stm32-h7-core-v13.pty \
           run docs/examples/stm32h7_touch_demo.py
  4. Click on the display in the browser canvas.

The lv_micropython firmware needs the patches under
user_modules/lv_binding_micropython/driver/stm32/st_ltdc/ to recognise
VERSION="VELXIO" and skip the GT911 touch init in Renode.
"""
import lvgl as lv
import display_driver
import stm
import time

# ── Single-buffer DIRECT mode ────────────────────────────────────────────
# display_driver defaults to double-buffer DIRECT, but the Velxio backend
# poller reads the buffer LTDC is currently scanning — which alternates
# behind LVGL's back, making post-render updates invisible. With a single
# buffer LTDC and LVGL share the same SDRAM region and every change is
# immediately in the bytes the poller reads.
disp_drv = lv.display_get_default()
buf1 = display_driver.disp.framebuffer(1)
disp_drv.set_buffers(buf1, None, len(buf1), lv.DISPLAY_RENDER_MODE.DIRECT)

# ── Touch mailbox layout ─────────────────────────────────────────────────
# Must match RenodeManager.TOUCH_MAILBOX in the backend.
TOUCH    = 0xC1F00000
TOUCH_PR = TOUCH + 0x00     # uint32: pressed flag (0 or 1)
TOUCH_X  = TOUCH + 0x04     # uint32: x in display pixels (0..1023)
TOUCH_Y  = TOUCH + 0x08     # uint32: y in display pixels (0..599)

# Zero the mailbox at startup so the first read isn't garbage from SDRAM.
stm.mem32[TOUCH_PR] = 0
stm.mem32[TOUCH_X]  = 0
stm.mem32[TOUCH_Y]  = 0

# ── UI ───────────────────────────────────────────────────────────────────
scr = lv.screen_active()
scr.set_style_bg_color(lv.color_hex(0x0e1726), 0)
scr.set_style_bg_opa(255, 0)
# Disable screen scrolling — otherwise LVGL v9 treats small drags on the
# screen as scroll attempts and steals the gesture from child widgets.
scr.remove_flag(lv.obj.FLAG.SCROLLABLE)

title = lv.label(scr)
title.set_text('Velxio  STM32H7  Touch Demo')
title.set_style_text_color(lv.color_hex(0xffffff), 0)
title.align(lv.ALIGN.TOP_MID, 0, 24)

counter_lbl = lv.label(scr)
counter_lbl.set_text('Clicks: 0')
counter_lbl.set_style_text_color(lv.color_hex(0xa0c4ff), 0)
counter_lbl.align(lv.ALIGN.TOP_MID, 0, 60)

btn = lv.button(scr)
btn.set_size(280, 110)
btn.center()
btn.set_style_bg_color(lv.color_hex(0xff8040), 0)
btn.set_style_radius(18, 0)
btn_lbl = lv.label(btn)
btn_lbl.set_text('Tap me!')
btn_lbl.set_style_text_color(lv.color_hex(0x000000), 0)
btn_lbl.center()

clicks = [0]
def on_btn_clicked(e):
    clicks[0] += 1
    counter_lbl.set_text('Clicks: ' + str(clicks[0]))
    lv.refr_now(disp_drv)
btn.add_event_cb(on_btn_clicked, lv.EVENT.CLICKED, None)

sld = lv.slider(scr)
sld.set_size(700, 36)
sld.align(lv.ALIGN.BOTTOM_MID, 0, -90)
sld.set_range(0, 100)
#sld.set_value(40, lv.ANIM.OFF)

sld_lbl = lv.label(scr)
sld_lbl.set_text('Slider: 40')
sld_lbl.set_style_text_color(lv.color_hex(0xa0c4ff), 0)
sld_lbl.align(lv.ALIGN.BOTTOM_MID, 0, -50)

def on_sld_changed(e):
    sld_lbl.set_text('Slider: ' + str(sld.get_value()))
    lv.refr_now(disp_drv)
sld.add_event_cb(on_sld_changed, lv.EVENT.VALUE_CHANGED, None)

# ── Custom LVGL indev driver — reads the Velxio touch mailbox ────────────
def read_velxio_touch(indev, data):
    pressed = stm.mem32[TOUCH_PR] & 0x1
    x = stm.mem32[TOUCH_X]
    y = stm.mem32[TOUCH_Y]
    if x > 1023: x = 1023
    if y > 599:  y = 599
    data.point.x = x
    data.point.y = y
    data.state = lv.INDEV_STATE.PRESSED if pressed else lv.INDEV_STATE.RELEASED

indev = lv.indev_create()
indev.set_type(lv.INDEV_TYPE.POINTER)
indev.set_read_cb(read_velxio_touch)

# ── Initial render — populate the buffer so something is visible while
# the user is still moving the cursor towards the canvas.
for _ in range(60):
    scr.invalidate()
    lv.tick_inc(20)
    lv.timer_handler()
    lv.refr_now(disp_drv)

# ── Idle loop — pump LVGL so the indev callback fires and widgets stay
# responsive even if lv_utils.event_loop drifts on Renode.
while True:
    lv.tick_inc(15)
    lv.timer_handler()
    time.sleep_ms(15)
