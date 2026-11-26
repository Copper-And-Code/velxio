/**
 * Pin function tables for every OSS board kind (DESIGN section 5.2).
 *
 * Importing this module registers them. The pro overlay registers its own
 * boards the same way, through registerBoardPinFunctions.
 */
import type { BoardKind } from '../../../types/board';
import { registerBoardPinFunctions, type BoardPinFunctions } from '../pinFunctions';
import { ATMEGA2560_TABLE, ATMEGA328P_TABLE, ATTINY85_TABLE } from './avr';
import { PICO_TABLE } from './rp2040';
import {
  ESP32_CAM_TABLE,
  ESP32_DEVKIT_C_V4_TABLE,
  ESP32_DEVKIT_V1_TABLE,
  LOLIN32_LITE_TABLE,
} from './esp32';
import { ESP32S3_DEVKITC_TABLE, NANO_ESP32_TABLE, XIAO_ESP32S3_TABLE } from './esp32s3';
import { ESP32C3_DEVKITM_TABLE, ESP32C3_SUPERMINI_TABLE, XIAO_ESP32C3_TABLE } from './esp32c3';
import {
  BLACKPILL_F401_TABLE,
  BLACKPILL_F411_TABLE,
  BLUEPILL_F103_TABLE,
  DISCO_F407_TABLE,
  GENERIC_F205RG_TABLE,
  GENERIC_F405RG_TABLE,
} from './stm32';
import { BCM2711_TABLE, BCM2835_TABLE, RP1_TABLE } from './raspberryPi';

/** Board kind -> table. Typed over the OSS union so a new kind without a table fails to compile. */
export const OSS_BOARD_PIN_TABLES: Record<BoardKind, BoardPinFunctions> = {
  'arduino-uno': ATMEGA328P_TABLE,
  'arduino-nano': ATMEGA328P_TABLE,
  'arduino-mega': ATMEGA2560_TABLE,
  attiny85: ATTINY85_TABLE,
  'raspberry-pi-pico': PICO_TABLE,
  'pi-pico-w': PICO_TABLE,
  esp32: ESP32_DEVKIT_V1_TABLE,
  'esp32-devkit-c-v4': ESP32_DEVKIT_C_V4_TABLE,
  'esp32-cam': ESP32_CAM_TABLE,
  'wemos-lolin32-lite': LOLIN32_LITE_TABLE,
  'esp32-s3': ESP32S3_DEVKITC_TABLE,
  'xiao-esp32-s3': XIAO_ESP32S3_TABLE,
  'arduino-nano-esp32': NANO_ESP32_TABLE,
  'esp32-c3': ESP32C3_DEVKITM_TABLE,
  'xiao-esp32-c3': XIAO_ESP32C3_TABLE,
  'aitewinrobot-esp32c3-supermini': ESP32C3_SUPERMINI_TABLE,
  'stm32-bluepill': BLUEPILL_F103_TABLE,
  'stm32-bluepill-f103cb': BLUEPILL_F103_TABLE,
  'stm32-blackpill': BLACKPILL_F411_TABLE,
  'stm32-blackpill-f401': BLACKPILL_F401_TABLE,
  'stm32-f4-discovery': DISCO_F407_TABLE,
  'stm32-olimex-h405': GENERIC_F405RG_TABLE,
  'stm32-netduino-plus2': GENERIC_F405RG_TABLE,
  'stm32-netduino2': GENERIC_F205RG_TABLE,
  'raspberry-pi-zero': BCM2835_TABLE,
  'raspberry-pi-1': BCM2835_TABLE,
  'raspberry-pi-2': BCM2835_TABLE,
  'raspberry-pi-3': BCM2835_TABLE,
  'raspberry-pi-4': BCM2711_TABLE,
  'raspberry-pi-5': RP1_TABLE,
  // STM32H743 Core in Renode: only USART1 on PA9/PA10 (AF7), the MicroPython
  // REPL, is bridged (with GPIO and the LTDC panel). Its other I2C/SPI/UART
  // controllers have no canvas part behind them, so they are not listed.
  // ESP32-4848S040: its UART0 header (the REPL) is the bus the canvas reaches; the
  // touch is on I2C0 inside the board (GPIO19/45, no pads).
  'esp32-4848s040': {
    routing: 'matrix',
    controllers: [{ bus: 'uart', unit: 0, name: 'UART0', defaultPins: { tx: 43, rx: 44 } }],
    pins: {
      43: [{ bus: 'uart', unit: 0, signal: 'tx' }],
      44: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    },
    source: 'ESP32-S3 datasheet: UART0 on GPIO43/44 (IO_MUX), the console of the ESP32-4848S040',
  },
  // Waveshare RP2350-Touch-LCD-4: its UART0 header (the REPL of the VELXIO firmware).
  'waveshare-rp2350-lcd4': {
    routing: 'matrix',
    controllers: [{ bus: 'uart', unit: 0, name: 'UART0', defaultPins: { tx: 46, rx: 45 } }],
    pins: {
      46: [{ bus: 'uart', unit: 0, signal: 'tx' }],
      45: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    },
    source: 'RP2350 datasheet GPIO function table: UART0 TX on GP46, RX on GP45 (RP2350B)',
  },
  'stm32h7-core-v13': {
    routing: 'mux',
    controllers: [{ bus: 'uart', unit: 0, name: 'USART1', defaultPins: { tx: 9, rx: 10 } }],
    pins: {
      9: [{ bus: 'uart', unit: 0, signal: 'tx' }],
      10: [{ bus: 'uart', unit: 0, signal: 'rx' }],
    },
    source:
      'RM0433/DS12110 (STM32H743) AF7 USART1 on PA9/PA10, the REPL UART of the ' +
      'STM32H7_CORE VELXIO firmware (copper-and-code-mcu-boards); the only bus Renode bridges',
  },
};

for (const [kind, table] of Object.entries(OSS_BOARD_PIN_TABLES)) {
  registerBoardPinFunctions([kind], table);
}
