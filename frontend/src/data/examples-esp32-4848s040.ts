/**
 * ESP32-4848S040 (esp32-4848s040) gallery examples: MicroPython + LVGL on its 4"
 * 480x480 panel, running the board's VELXIO firmware on our QEMU's esp32s3-picsimlab
 * machine. `import display_driver` starts the panel, LVGL, the GT911 touch (the canvas)
 * and a background lv.timer_handler(), as on the board.
 */
import type { ExampleProject } from './examples';

const TOUCH_DEMO = `# ESP32-4848S040 + LVGL: a button and a slider on the 480x480 panel.
# Click and drag on the board's screen in the canvas: it is the touch (GT911).
import lvgl as lv
import display_driver

scr = lv.screen_active()
scr.set_style_bg_color(lv.color_hex(0x0e1726), 0)
scr.remove_flag(lv.obj.FLAG.SCROLLABLE)

title = lv.label(scr)
title.set_text('ESP32-S3 + LVGL')
title.set_style_text_color(lv.color_hex(0xffffff), 0)
title.align(lv.ALIGN.TOP_MID, 0, 24)

clicks = lv.label(scr)
clicks.set_text('Clicks: 0')
clicks.set_style_text_color(lv.color_hex(0xa0c4ff), 0)
clicks.align(lv.ALIGN.TOP_MID, 0, 56)

btn = lv.button(scr)
btn.set_size(220, 100)
btn.center()
btn.set_style_bg_color(lv.color_hex(0x2a9d8f), 0)
lbl = lv.label(btn)
lbl.set_text('Tap me!')
lbl.center()

count = [0]
def on_click(e):
    count[0] += 1
    clicks.set_text('Clicks: %d' % count[0])
btn.add_event_cb(on_click, lv.EVENT.CLICKED, None)

slider = lv.slider(scr)
slider.set_size(380, 30)
slider.align(lv.ALIGN.BOTTOM_MID, 0, -80)
value = lv.label(scr)
value.set_text('Slider: 0')
value.set_style_text_color(lv.color_hex(0xa0c4ff), 0)
value.align(lv.ALIGN.BOTTOM_MID, 0, -40)
slider.add_event_cb(lambda e: value.set_text('Slider: %d' % slider.get_value()),
                    lv.EVENT.VALUE_CHANGED, None)
`;

export const esp32_4848s040Examples: ExampleProject[] = [
  {
    id: 'esp32-4848s040-lvgl-touch',
    title: 'ESP32-4848S040: LVGL touch',
    description:
      'A button and a slider on the 4" 480x480 panel of the ESP32-4848S040 (ESP32-S3), in MicroPython with LVGL. The board screen in the canvas is the GT911 touch screen.',
    category: 'displays',
    difficulty: 'beginner',
    boardType: 'esp32-4848s040',
    boardFilter: 'esp32-4848s040',
    languageMode: 'micropython',
    tags: ['esp32', 'esp32-s3', 'micropython', 'lvgl', 'touch', 'gt911'],
    code: TOUCH_DEMO,
    components: [],
    wires: [],
  },
];
