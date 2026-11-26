/**
 * Waveshare RP2350-Touch-LCD-4 (waveshare-rp2350-lcd4) gallery examples: MicroPython +
 * LVGL on its 4" panel, running the board's VELXIO firmware on our QEMU's raspi-pico2
 * machine. `import display_driver` starts the panel (480x480: Velxio fits the board's
 * optional 8 MB PSRAM), LVGL, the GT911 touch (the canvas) and a background
 * lv.timer_handler().
 */
import type { ExampleProject } from './examples';

const TOUCH_DEMO = `# Waveshare RP2350-Touch-LCD-4 + LVGL: a button and a slider.
# Click and drag on the board's screen in the canvas: it is the touch (GT911).
import lvgl as lv
import display_driver

W, H = display_driver.WIDTH, display_driver.HEIGHT   # 480x480 (240x240 without PSRAM)

scr = lv.screen_active()
scr.set_style_bg_color(lv.color_hex(0x12261c), 0)
scr.remove_flag(lv.obj.FLAG.SCROLLABLE)

title = lv.label(scr)
title.set_text('RP2350 + LVGL')
title.set_style_text_color(lv.color_hex(0xffffff), 0)
title.align(lv.ALIGN.TOP_MID, 0, H // 20)

clicks = lv.label(scr)
clicks.set_text('Clicks: 0')
clicks.set_style_text_color(lv.color_hex(0xa5d6a7), 0)
clicks.align(lv.ALIGN.TOP_MID, 0, H // 6)

btn = lv.button(scr)
btn.set_size(W // 2, H // 5)
btn.center()
btn.set_style_bg_color(lv.color_hex(0x2e7d32), 0)
lbl = lv.label(btn)
lbl.set_text('Tap me!')
lbl.center()

count = [0]
def on_click(e):
    count[0] += 1
    clicks.set_text('Clicks: %d' % count[0])
btn.add_event_cb(on_click, lv.EVENT.CLICKED, None)

slider = lv.slider(scr)
slider.set_width(W * 3 // 4)
slider.align(lv.ALIGN.BOTTOM_MID, 0, -H // 6)
value = lv.label(scr)
value.set_text('Slider: 0')
value.set_style_text_color(lv.color_hex(0xa5d6a7), 0)
value.align(lv.ALIGN.BOTTOM_MID, 0, -H // 14)
slider.add_event_cb(lambda e: value.set_text('Slider: %d' % slider.get_value()),
                    lv.EVENT.VALUE_CHANGED, None)
`;

export const waveshareRp2350Lcd4Examples: ExampleProject[] = [
  {
    id: 'waveshare-rp2350-lcd4-lvgl-touch',
    title: 'RP2350-Touch-LCD-4: LVGL touch',
    description:
      'A button and a slider on the 4" panel of the Waveshare RP2350-Touch-LCD-4 (RP2350B), in MicroPython with LVGL. The board screen in the canvas is the GT911 touch screen.',
    category: 'displays',
    difficulty: 'beginner',
    boardType: 'waveshare-rp2350-lcd4',
    boardFilter: 'waveshare-rp2350-lcd4',
    languageMode: 'micropython',
    tags: ['rp2350', 'micropython', 'lvgl', 'touch', 'gt911'],
    code: TOUCH_DEMO,
    components: [],
    wires: [],
  },
];
