/**
 * The STM32H743 Core's canvas geometry and header pads (stm32h7-core-v13):
 * the board frame Stm32H7Display draws, and the pads PinOverlay reads from
 * its `pinInfo`. A module of its own so tests and pin tables can read the
 * pads without mounting the React component.
 */

// ── Frame layout (CSS px, world coords) ──────────────────────────────────────
// The board is rendered as a PCB-style frame with the LTDC display centred and
// 24 GPIO header pins (12 top + 12 bottom) along the long edges. Pin coords
// match what `PinOverlay` reads from `pinInfo`, so the click-target and the
// visible gold pad always line up.
export const FRAME_W = 470;
export const FRAME_H = 348;
export const SCREEN_W = 410;        // 1024 × 0.4 — natural CSS size of the LTDC panel
export const SCREEN_H = 240;        // 600  × 0.4
export const SCREEN_X = (FRAME_W - SCREEN_W) / 2; // 30 — equal padding L/R
export const SCREEN_Y = 58;         // leaves room for title + top pin row
export const TOP_PIN_Y = 37;
export const BOT_PIN_Y = 311;
export const PIN_X = (i: number): number => Math.round(SCREEN_X + 17 + i * 34);
export interface Stm32PinSignal {
  type: string;
  signal?: string;
  voltage?: number;
}

export interface Stm32PinDef {
  name: string;
  x: number;
  y: number;
  signals: Stm32PinSignal[];
  description?: string;
}

// V13 free-pin subset suitable for Arduino-style breadboarding.
// Reserved-by-firmware pins (PA1 user button, PB0/PB1 LEDs, FMC SDRAM bus,
// QSPI flash, LTDC panel bus, USB FS) are intentionally NOT exposed —
// they're already wired internally in the Renode .repl. PA9/PA10 are
// listed even though the REPL uses USART1, so the user can detach the
// monitor and repurpose them as plain GPIO if desired.
// The timer channel in a description is the one machine.PWM picks on the pad:
// the Renode lane reads its duty (backend/app/services/stm32h7_pads.py).
export const STM32H7_PINS: Stm32PinDef[] = [
  // ── Top row ────────────────────────────────────────────────────────────
  { name: '3V3',   x: PIN_X(0),  y: TOP_PIN_Y, signals: [{ type: 'power', signal: 'VCC', voltage: 3.3 }] },
  { name: 'GND.1', x: PIN_X(1),  y: TOP_PIN_Y, signals: [{ type: 'power', signal: 'GND' }] },
  { name: 'PA9',   x: PIN_X(2),  y: TOP_PIN_Y, signals: [{ type: 'usart', signal: 'TX' }],  description: 'USART1 TX (REPL)' },
  { name: 'PA10',  x: PIN_X(3),  y: TOP_PIN_Y, signals: [{ type: 'usart', signal: 'RX' }],  description: 'USART1 RX (REPL)' },
  { name: 'PA0',   x: PIN_X(4),  y: TOP_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC1_INP16, PWM (TIM5_CH1)' },
  { name: 'PA3',   x: PIN_X(5),  y: TOP_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC1_INP15, PWM (TIM5_CH4)' },
  { name: 'PA4',   x: PIN_X(6),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'NSS' }],   description: 'SPI1 NSS' },
  { name: 'PA5',   x: PIN_X(7),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'SCK' }],   description: 'SPI1 SCK, PWM (TIM2_CH1)' },
  { name: 'PA6',   x: PIN_X(8),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'MISO' }],  description: 'SPI1 MISO, PWM (TIM13_CH1)' },
  { name: 'PA7',   x: PIN_X(9),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'MOSI' }],  description: 'SPI1 MOSI, PWM (TIM14_CH1)' },
  { name: 'PB7',   x: PIN_X(10), y: TOP_PIN_Y, signals: [],                                 description: 'PWM (TIM4_CH2)' },
  { name: 'PB15',  x: PIN_X(11), y: TOP_PIN_Y, signals: [],                                 description: 'PWM (TIM12_CH2)' },
  // ── Bottom row ─────────────────────────────────────────────────────────
  { name: '5V',    x: PIN_X(0),  y: BOT_PIN_Y, signals: [{ type: 'power', signal: 'VCC', voltage: 5 }] },
  { name: 'GND.2', x: PIN_X(1),  y: BOT_PIN_Y, signals: [{ type: 'power', signal: 'GND' }] },
  { name: 'PB8',   x: PIN_X(2),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SCL' }],   description: 'I2C1 SCL, PWM (TIM4_CH3)' },
  { name: 'PB9',   x: PIN_X(3),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SDA' }],   description: 'I2C1 SDA, PWM (TIM4_CH4)' },
  { name: 'PB10',  x: PIN_X(4),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SCL' }],   description: 'I2C2 SCL, PWM (TIM2_CH3)' },
  { name: 'PB11',  x: PIN_X(5),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SDA' }],   description: 'I2C2 SDA, PWM (TIM2_CH4)' },
  { name: 'PC0',   x: PIN_X(6),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP10' },
  { name: 'PC1',   x: PIN_X(7),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP11' },
  { name: 'PC2',   x: PIN_X(8),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP12' },
  { name: 'PC3',   x: PIN_X(9),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP13' },
  { name: 'PC13',  x: PIN_X(10), y: BOT_PIN_Y, signals: [] },
  { name: 'PC14',  x: PIN_X(11), y: BOT_PIN_Y, signals: [] },
];
