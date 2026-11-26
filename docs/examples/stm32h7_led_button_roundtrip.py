"""
Velxio STM32H7 + LVGL + external LED/button roundtrip demo.

What it demonstrates:
  - Touch on an LVGL button controls an external LED on PA9.
  - An external pushbutton on PA0 updates a label and moves a bar on the LTDC.

Suggested wiring in the Velxio canvas:
  - LED anode   -> STM32H7 PA9
  - LED cathode -> STM32H7 GND.1 or GND.2
  - Pushbutton  -> STM32H7 PA0 and 3V3

The PA0 input is configured with PULL_DOWN, so the button should drive PA0 high
when pressed. If you wire the button to GND instead, change BUTTON_ACTIVE_HIGH
to False and use Pin.PULL_UP.

Run with:
  mpremote connect /tmp/velxio-stm32-stm32-h7-core-v13.pty \
    run docs/examples/stm32h7_led_button_roundtrip.py
"""

import time

# display_driver starts the panel, LVGL, the touch (the Velxio canvas) and a
# background lv.timer_handler(): the loop at the end only watches the button.
import display_driver
import lvgl as lv
from machine import Pin


try:
    ANIM_OFF = lv.ANIM.OFF
except AttributeError:
    ANIM_OFF = 0


# ── Hardware pins ─────────────────────────────────────────────────────────

LED_PIN = "A9"
BUTTON_PIN = "A0"
BUTTON_ACTIVE_HIGH = True

led = Pin(LED_PIN, Pin.OUT)
led.value(0)

try:
    button = Pin(BUTTON_PIN, Pin.IN, Pin.PULL_DOWN if BUTTON_ACTIVE_HIGH else Pin.PULL_UP)
except AttributeError:
    # Some MicroPython STM32 builds omit pull constants. The Velxio pushbutton
    # still drives the pin explicitly through Renode, so a plain input works.
    button = Pin(BUTTON_PIN, Pin.IN)


# ── UI ───────────────────────────────────────────────────────────────────

scr = lv.screen_active()
scr.set_style_bg_color(lv.color_hex(0x101820), 0)
scr.set_style_bg_opa(255, 0)
scr.remove_flag(lv.obj.FLAG.SCROLLABLE)

title = lv.label(scr)
title.set_text("STM32H7 LVGL <-> GPIO Roundtrip")
title.set_style_text_color(lv.color_hex(0xFFFFFF), 0)
title.align(lv.ALIGN.TOP_MID, 0, 24)

subtitle = lv.label(scr)
subtitle.set_text("LVGL button drives PA9 LED - PA0 button updates the screen")
subtitle.set_style_text_color(lv.color_hex(0x9CC9D6), 0)
subtitle.align(lv.ALIGN.TOP_MID, 0, 56)

led_btn = lv.obj(scr)
led_btn.set_size(300, 120)
led_btn.align(lv.ALIGN.LEFT_MID, 90, -20)
led_btn.add_flag(lv.obj.FLAG.CLICKABLE)
led_btn.remove_flag(lv.obj.FLAG.SCROLLABLE)
led_btn.set_style_radius(18, 0)
led_btn.set_style_bg_color(lv.color_hex(0x2A9D8F), 0)
led_btn.set_style_border_width(0, 0)

led_btn_label = lv.label(led_btn)
led_btn_label.set_text("LVGL LED: OFF")
led_btn_label.set_style_text_color(lv.color_hex(0xFFFFFF), 0)
led_btn_label.center()

status = lv.label(scr)
status.set_text("External button PA0: waiting")
status.set_style_text_color(lv.color_hex(0xE9C46A), 0)
status.align(lv.ALIGN.RIGHT_MID, -110, -62)

counter_label = lv.label(scr)
counter_label.set_text("External presses: 0")
counter_label.set_style_text_color(lv.color_hex(0xFFFFFF), 0)
counter_label.align(lv.ALIGN.RIGHT_MID, -164, -22)

bar = lv.bar(scr)
bar.set_size(330, 34)
bar.align(lv.ALIGN.RIGHT_MID, -90, 32)
bar.set_range(0, 20)
bar.set_value(0, ANIM_OFF)

hint = lv.label(scr)
hint.set_text("Wire: PA9 -> LED -> GND, PA0 -> pushbutton -> 3V3")
hint.set_style_text_color(lv.color_hex(0x8D99AE), 0)
hint.align(lv.ALIGN.BOTTOM_MID, 0, -38)

led_state = [0]
button_presses = [0]


def set_led_state(value):
    next_state = 1 if value else 0
    if led_state[0] == next_state:
        led.value(next_state)
        return

    led_state[0] = next_state
    led.value(next_state)
    led_btn_label.set_text("LVGL LED: " + ("ON" if next_state else "OFF"))
    led_btn.set_style_bg_color(lv.color_hex(0xE76F51 if next_state else 0x2A9D8F), 0)


def on_led_button(event):
    set_led_state(0 if led_state[0] else 1)


led_btn.add_event_cb(on_led_button, lv.EVENT.CLICKED, None)


def button_is_pressed():
    raw = button.value()
    return bool(raw) if BUTTON_ACTIVE_HIGH else not bool(raw)


last_button = button_is_pressed()


def handle_external_button():
    global last_button
    current = button_is_pressed()
    if current == last_button:
        return

    last_button = current

    if not current:
        return

    button_presses[0] += 1
    status.set_text("External button PA0: pressed")
    counter_label.set_text("External presses: " + str(button_presses[0]))
    bar.set_value(button_presses[0] % 21, ANIM_OFF)


# ── Main loop: LVGL runs in the background (display_driver) ───────────────

while True:
    handle_external_button()
    time.sleep_ms(15)
