/**
 * STM32H743 Core (stm32h7-core-v13) gallery examples.
 *
 * The board runs the STM32H7_CORE VELXIO firmware of copper-and-code-mcu-boards
 * (MicroPython + LVGL) in Renode on the backend; the program is pasted into its
 * REPL at boot. `import display_driver` starts the 1024x600 panel, LVGL, the touch
 * (the canvas, through a mailbox) and a background lv.timer_handler(), so these
 * programs have no main loop.
 */
import type { ExampleProject } from './examples';
import STM32H7_ADVANCED_DEMO from './stm32-advanced-demo.py?raw';

const TOUCH_DEMO = `# STM32H743 Core + LVGL: a button and a slider on the 1024x600 panel.
# Click and drag on the board's screen in the canvas: it is the touch.
import lvgl as lv
import display_driver

scr = lv.screen_active()
scr.set_style_bg_color(lv.color_hex(0x0e1726), 0)
scr.remove_flag(lv.obj.FLAG.SCROLLABLE)

title = lv.label(scr)
title.set_text('STM32H743 + LVGL')
title.set_style_text_color(lv.color_hex(0xffffff), 0)
title.align(lv.ALIGN.TOP_MID, 0, 24)

clicks = lv.label(scr)
clicks.set_text('Clicks: 0')
clicks.set_style_text_color(lv.color_hex(0xa0c4ff), 0)
clicks.align(lv.ALIGN.TOP_MID, 0, 60)

btn = lv.button(scr)
btn.set_size(280, 110)
btn.center()
btn.set_style_bg_color(lv.color_hex(0xff8040), 0)
lbl = lv.label(btn)
lbl.set_text('Tap me!')
lbl.center()

count = [0]
def on_click(e):
    count[0] += 1
    clicks.set_text('Clicks: %d' % count[0])
btn.add_event_cb(on_click, lv.EVENT.CLICKED, None)

slider = lv.slider(scr)
slider.set_size(700, 36)
slider.align(lv.ALIGN.BOTTOM_MID, 0, -90)
value = lv.label(scr)
value.set_text('Slider: 0')
value.set_style_text_color(lv.color_hex(0xa0c4ff), 0)
value.align(lv.ALIGN.BOTTOM_MID, 0, -50)
slider.add_event_cb(lambda e: value.set_text('Slider: %d' % slider.get_value()),
                    lv.EVENT.VALUE_CHANGED, None)
`;

export const stm32h7Examples: ExampleProject[] = [
  {
    id: 'stm32h7-lvgl-touch',
    title: 'STM32H743 Core: LVGL touch',
    description:
      'A button and a slider on the 1024x600 LTDC panel of the STM32H743 Core, in MicroPython with LVGL. The board screen in the canvas is the touch screen.',
    category: 'displays',
    difficulty: 'beginner',
    boardType: 'stm32h7-core-v13',
    boardFilter: 'stm32h7-core-v13',
    languageMode: 'micropython',
    tags: ['stm32', 'stm32h7', 'micropython', 'lvgl', 'touch', 'ltdc'],
    code: TOUCH_DEMO,
    components: [],
    wires: [],
  },
  {
    id: 'stm32h7-lvgl-advanced',
    title: 'STM32H743 Core: LVGL advanced demo',
    description:
      'Tabs, buttons, styled widgets, text and an animated chart: the LVGL advanced demo on the STM32H743 Core, in MicroPython.',
    category: 'displays',
    difficulty: 'advanced',
    boardType: 'stm32h7-core-v13',
    boardFilter: 'stm32h7-core-v13',
    languageMode: 'micropython',
    tags: ['stm32', 'stm32h7', 'micropython', 'lvgl', 'tabview', 'chart', 'ltdc'],
    code: STM32H7_ADVANCED_DEMO,
    components: [],
    wires: [],
  },
];
