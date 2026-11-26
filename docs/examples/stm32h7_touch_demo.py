"""
Velxio STM32H7 + LVGL touch demo (runnable).

Builds a tiny LVGL UI (centered button + slider) on the 1024x600 LTDC
display. The browser canvas is the touch screen: `import display_driver`
registers it as the LVGL pointer (velxio_touch.py in the firmware reads the
mailbox the backend writes, see docs/STM32H7_MANUAL_TEST.md section 8), and
serves LVGL in the background, so the program has no main loop.

Usage:
  1. Start the Velxio backend + frontend.
  2. Click "Run" on the STM32H7 board in the browser; wait for REPL.
  3. From the host:
       mpremote connect /tmp/velxio-stm32-stm32-h7-core-v13.pty \
           run docs/examples/stm32h7_touch_demo.py
  4. Click on the display in the browser canvas.

Firmware: the STM32H7_CORE VELXIO variant of copper-and-code-mcu-boards.
"""
import lvgl as lv
import display_driver

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
sld.add_event_cb(on_sld_changed, lv.EVENT.VALUE_CHANGED, None)
