# Example Projects

This folder contains standalone example programs and notes for the examples
available from the Velxio gallery.

## Available Examples

| ID                             | Title                        | Category      | Difficulty   | Components                        |
| ------------------------------ | ---------------------------- | ------------- | ------------ | --------------------------------- |
| `blink-led`                    | Blink LED                    | basics        | beginner     | Arduino Uno                       |
| `traffic-light`                | Traffic Light                | basics        | beginner     | 3 LEDs (R/Y/G)                    |
| `button-led`                   | Button Control               | basics        | beginner     | Button + LED                      |
| `fade-led`                     | Fade LED (PWM)               | basics        | beginner     | 1 LED                             |
| `serial-hello`                 | Serial Hello World           | communication | beginner     | Arduino Uno                       |
| `rgb-led`                      | RGB LED Colors               | basics        | intermediate | RGB LED                           |
| `simon-says`                   | Simon Says Game              | games         | advanced     | 4 LEDs + 4 buttons                |
| `lcd-hello`                    | LCD 20x4 Display             | displays      | intermediate | LCD 2004                          |
| `stm32h7-advanced-demo`        | STM32H7 Advanced Demo        | displays      | advanced     | STM32H743 CORE V13 + LTDC         |
| `stm32h7-led-button-roundtrip` | STM32H7 LED/Button Roundtrip | displays      | beginner     | STM32H743 CORE V13 + LED + button |

Each example includes:

- Complete Arduino sketch code
- Component definitions with positions
- Wire connections with pin names and colors

The STM32H7 advanced demo is maintained as `advanced_demo.py`. The frontend
imports the same program as the default `main.py` for a newly opened
STM32H743 CORE V13 simulator.

The STM32H7 LED/Button Roundtrip demo is maintained as
`stm32h7_led_button_roundtrip.py`. It validates both directions of the
architecture:

- LVGL touch button -> MicroPython GPIO output -> external LED on `PA9`
- external pushbutton -> Velxio GPIO input -> MicroPython polling on `PA0`
  -> label/bar update on the LTDC display

The suggested pushbutton wiring is `3V3 -> pushbutton -> PA0`; the simulator
now treats this as an active-high input. Wiring to `GND` remains active-low.
The demo intentionally performs a single explicit initial render instead of a
long warm-up loop, because repeated startup refreshes are visible on the
Renode/LTDC path.

The examples are defined in `frontend/src/data/examples.ts` and rendered in the `ExamplesGallery.tsx` gallery with category and difficulty filters.

## How to Create Screenshots

### Method 1: Manual Capture (Recommended)

1. Load the example in the editor (http://localhost:5173/examples)
2. Click the example to load it
3. Adjust the canvas zoom if needed
4. Use a screenshot tool to capture only the simulator area
5. Save the image with the corresponding name

### Method 2: Using DevTools

1. Open the example in the browser
2. Open DevTools (F12)
3. Go to the console and run:

```javascript
const canvas = document.querySelector(".canvas-content");
html2canvas(canvas).then((canvas) => {
  const link = document.createElement("a");
  link.download = "example-name.png";
  link.href = canvas.toDataURL();
  link.click();
});
```

## File Names

Files must follow the example ID:

- `blink-led.png` — Blink LED
- `traffic-light.png` — Traffic Light
- `button-led.png` — Button Control
- `fade-led.png` — Fade LED
- `serial-hello.png` — Serial Hello World
- `rgb-led.png` — RGB LED Colors
- `simon-says.png` — Simon Says Game
- `lcd-hello.png` — LCD 20x4 Display

## Recommended Dimensions

- **Width**: 800px
- **Height**: 500px
- **Format**: PNG with dark background (#1e1e1e)

## Current Placeholder

While no images are available, a placeholder is shown with:

- Category icon (large emoji)
- Number of components (cyan blue)
- Number of wires (yellow)
- Gradient background with dashed border

## Adding a New Example

1. Add the definition in `frontend/src/data/examples.ts` with:
   - `id`, `title`, `description`, `category`, `difficulty`
   - `code`: Complete Arduino sketch
   - `components[]`: Type, position, properties
   - `wires[]`: Connections with `startPinName`, `endPinName`, `color`
2. (Optional) Capture a screenshot and save it here as `{id}.png`
3. The example will automatically appear in the gallery with category and difficulty filtering
