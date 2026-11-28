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

const LINE_ROBOT = `# STM32H743 Core line robot: the board and its screen ride on the robot.
#
# Wiring (the header of the board):
#   PB8  -> L293D EN1 (left motor speed, PWM: TIM4 channel 3)   left motor on OUT1/OUT2
#   PB9  -> L293D EN2 (right motor speed, PWM: TIM4 channel 4)  right motor on OUT3/OUT4
#   L293D IN1, IN3 on 3V3 and IN2, IN4 on GND: both motors turn forward only
#   PB10 <- left line sensor DO, PB11 <- right line sensor DO (1 over the tape)
#
# Open the World (3D button) and press Run. The screen on the robot is this
# app: touch STOP / START on it, in the 3D scene or on the canvas.
import display_driver
import lvgl as lv
import time
from machine import Pin, PWM

CRUISE, TURN = 0.38, 0.6               # duty, 0..1

left = PWM(Pin('B8'), freq=1000, duty_u16=0)
right = PWM(Pin('B9'), freq=1000, duty_u16=0)
line_l = Pin('B10', Pin.IN)
line_r = Pin('B11', Pin.IN)
state = {'run': True, 'l': None, 'r': None, 'last': None, 'ticks': 0, 't0': time.ticks_ms()}

GREEN, RED, GREY = 0x2ecc71, 0xff3b30, 0x5a6270


def font(size):
    return getattr(lv, 'font_montserrat_%d' % size, None)


scr = lv.obj()
scr.set_style_bg_color(lv.color_hex(0x10151c), 0)
scr.remove_flag(lv.obj.FLAG.SCROLLABLE)

title = lv.label(scr)
title.set_text('LINE ROBOT')
title.set_style_text_color(lv.color_hex(0xffffff), 0)
if font(28):
    title.set_style_text_font(font(28), 0)
title.align(lv.ALIGN.TOP_MID, 0, 24)


def eye(x):
    o = lv.obj(scr)
    o.set_size(150, 150)
    o.set_style_radius(75, 0)
    o.set_style_border_width(6, 0)
    o.set_style_border_color(lv.color_hex(0xffffff), 0)
    o.set_style_bg_color(lv.color_hex(GREY), 0)
    o.remove_flag(lv.obj.FLAG.SCROLLABLE)
    o.align(lv.ALIGN.TOP_MID, x, 80)
    return o


eye_l, eye_r = eye(-130), eye(130)


def bar(y, text):
    lab = lv.label(scr)
    lab.set_text(text)
    lab.set_style_text_color(lv.color_hex(0xc9ccd3), 0)
    lab.align(lv.ALIGN.TOP_LEFT, 180, y + 4)
    b = lv.bar(scr)
    b.set_size(560, 28)
    b.set_range(0, 100)
    b.align(lv.ALIGN.TOP_LEFT, 290, y)
    return b


bar_l, bar_r = bar(280, 'LEFT'), bar(330, 'RIGHT')

rate = lv.label(scr)
rate.set_style_text_color(lv.color_hex(0x8a93a3), 0)
rate.align(lv.ALIGN.TOP_RIGHT, -24, 20)

btn = lv.button(scr)
btn.set_size(300, 110)
btn.align(lv.ALIGN.BOTTOM_MID, 0, -40)
btn_label = lv.label(btn)
btn_label.center()
if font(28):
    btn_label.set_style_text_font(font(28), 0)


def show_button():
    btn_label.set_text('STOP' if state['run'] else 'START')
    btn.set_style_bg_color(lv.color_hex(RED if state['run'] else GREEN), 0)


def toggle(e):
    state['run'] = not state['run']
    show_button()


btn.add_event_cb(toggle, lv.EVENT.CLICKED, None)
show_button()


def drive(dl, dr):
    left.duty_u16(int(dl * 65535))
    right.duty_u16(int(dr * 65535))
    bar_l.set_value(int(dl * 100), 0)          # 0: LV_ANIM_OFF
    bar_r.set_value(int(dr * 100), 0)


def tick(t):
    l, r = line_l.value(), line_r.value()
    # The two sensors sit inside the tape: both see it while the robot is on it.
    if not state['run']:
        drive(0, 0)
    elif l and not r:        # only the left one on the tape: turn left
        state['last'] = 'l'
        drive(0, TURN)
    elif r and not l:        # only the right one: turn right
        state['last'] = 'r'
        drive(TURN, 0)
    elif l and r:            # on the tape
        drive(CRUISE, CRUISE)
    elif state['last'] == 'l':   # lost it: turn back to where it was last seen
        drive(0, TURN)
    elif state['last'] == 'r':
        drive(TURN, 0)
    else:
        drive(CRUISE, CRUISE)
    if l != state['l']:
        state['l'] = l
        eye_l.set_style_bg_color(lv.color_hex(RED if l else GREEN), 0)
    if r != state['r']:
        state['r'] = r
        eye_r.set_style_bg_color(lv.color_hex(RED if r else GREEN), 0)
    state['ticks'] += 1
    dt = time.ticks_diff(time.ticks_ms(), state['t0'])
    if dt >= 2000:                       # how often the loop runs: steering needs ~20/s
        hz = state['ticks'] * 1000 // dt
        rate.set_text('%d Hz' % hz)
        print('loop', hz, 'Hz')
        state['ticks'], state['t0'] = 0, time.ticks_ms()


lv.timer_create(tick, 10, None)
lv.screen_load(scr)
print('line robot ready')
`;

const LINE_ROBOT_WORLD = `<!doctype html>
<html><body>
<script type="application/json" id="velxio-scene">
{
  "version": 1,
  "view": "3d",
  "follow": "robot1",
  "floor": { "w": 2.4, "h": 1.6, "grid": true },
  "objects": [
    { "id": "track1", "type": "track", "shape": "oval", "x": 0, "y": 0, "w": 2.1, "h": 1.1, "tape": 0.022 },
    { "id": "robot1", "type": "robot", "preset": "diff4", "x": -0.3, "y": -0.539, "rot": 0,
      "bind": { "left": ["h7-motor-l"], "right": ["h7-motor-r"], "line": ["h7-line-l", "h7-line-r"], "display": "stm32h7-core-v13" } }
  ]
}
</script>
<script>velxio.kit.start();</script>
</body></html>
`;

const H7 = 'stm32h7-core-v13';

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
  {
    id: 'stm32h7-line-robot',
    title: 'STM32H743 Core: Line Robot with its screen (World kit)',
    description:
      'The STM32H743 Core and its 1024x600 screen ride on a four-wheel robot in a World kit scene. A MicroPython app drives two DC motors through an L293D (PWM on PB8 and PB9, timer 4), reads two IR line sensors (PB10, PB11) and shows them on an LVGL dashboard: touch STOP / START on the screen of the robot.',
    category: 'robotics',
    difficulty: 'intermediate',
    boardType: 'stm32h7-core-v13',
    boardFilter: 'stm32h7-core-v13',
    languageMode: 'micropython',
    tags: ['stm32', 'stm32h7', 'micropython', 'lvgl', 'robot', 'pwm', 'world'],
    code: '',
    files: [{ name: 'main.py', content: LINE_ROBOT }],
    components: [
      { type: 'velxio-motor-driver-l293d', id: 'h7-l293d', x: 560, y: 60, properties: {} },
      { type: 'velxio-dc-motor', id: 'h7-motor-l', x: 730, y: 20, properties: { rpm: 200 } },
      { type: 'velxio-dc-motor', id: 'h7-motor-r', x: 730, y: 110, properties: { rpm: 200 } },
      { type: 'velxio-line-sensor', id: 'h7-line-l', x: 560, y: 230, properties: {} },
      { type: 'velxio-line-sensor', id: 'h7-line-r', x: 630, y: 230, properties: {} },
    ],
    wires: [
      { id: 'h7-en1', start: { componentId: H7, pinName: 'PB8' }, end: { componentId: 'h7-l293d', pinName: 'EN1' }, color: '#ff8800' },
      { id: 'h7-en2', start: { componentId: H7, pinName: 'PB9' }, end: { componentId: 'h7-l293d', pinName: 'EN2' }, color: '#ff8800' },
      { id: 'h7-in1', start: { componentId: H7, pinName: '3V3' }, end: { componentId: 'h7-l293d', pinName: 'IN1' }, color: '#ff0000' },
      { id: 'h7-in2', start: { componentId: H7, pinName: 'GND.1' }, end: { componentId: 'h7-l293d', pinName: 'IN2' }, color: '#000000' },
      { id: 'h7-in3', start: { componentId: H7, pinName: '3V3' }, end: { componentId: 'h7-l293d', pinName: 'IN3' }, color: '#ff0000' },
      { id: 'h7-in4', start: { componentId: H7, pinName: 'GND.1' }, end: { componentId: 'h7-l293d', pinName: 'IN4' }, color: '#000000' },
      { id: 'h7-vcc1', start: { componentId: H7, pinName: '3V3' }, end: { componentId: 'h7-l293d', pinName: 'VCC1' }, color: '#ff0000' },
      { id: 'h7-vcc2', start: { componentId: H7, pinName: '3V3' }, end: { componentId: 'h7-l293d', pinName: 'VCC2' }, color: '#ff0000' },
      { id: 'h7-gnd', start: { componentId: H7, pinName: 'GND.1' }, end: { componentId: 'h7-l293d', pinName: 'GND.1' }, color: '#000000' },
      { id: 'h7-ml1', start: { componentId: 'h7-l293d', pinName: 'OUT1' }, end: { componentId: 'h7-motor-l', pinName: 'M+' }, color: '#aa44cc' },
      { id: 'h7-ml2', start: { componentId: 'h7-l293d', pinName: 'OUT2' }, end: { componentId: 'h7-motor-l', pinName: 'M-' }, color: '#555555' },
      { id: 'h7-mr1', start: { componentId: 'h7-l293d', pinName: 'OUT3' }, end: { componentId: 'h7-motor-r', pinName: 'M+' }, color: '#aa44cc' },
      { id: 'h7-mr2', start: { componentId: 'h7-l293d', pinName: 'OUT4' }, end: { componentId: 'h7-motor-r', pinName: 'M-' }, color: '#555555' },
      { id: 'h7-ll-do', start: { componentId: H7, pinName: 'PB10' }, end: { componentId: 'h7-line-l', pinName: 'DO' }, color: '#ffcc00' },
      { id: 'h7-ll-v', start: { componentId: H7, pinName: '3V3' }, end: { componentId: 'h7-line-l', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'h7-ll-g', start: { componentId: H7, pinName: 'GND.2' }, end: { componentId: 'h7-line-l', pinName: 'GND' }, color: '#000000' },
      { id: 'h7-lr-do', start: { componentId: H7, pinName: 'PB11' }, end: { componentId: 'h7-line-r', pinName: 'DO' }, color: '#ffcc00' },
      { id: 'h7-lr-v', start: { componentId: H7, pinName: '3V3' }, end: { componentId: 'h7-line-r', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'h7-lr-g', start: { componentId: H7, pinName: 'GND.2' }, end: { componentId: 'h7-line-r', pinName: 'GND' }, color: '#000000' },
    ],
    world: { open: true, html: LINE_ROBOT_WORLD },
  },
];
