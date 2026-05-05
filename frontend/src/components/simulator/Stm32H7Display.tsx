import React, { useEffect, useRef, useState } from 'react';
import type { Stm32Framebuffer, Stm32PixelFormat } from '../../simulation/Stm32H7Bridge';
import { getStm32Bridge } from '../../store/useSimulatorStore';

// ── Frame layout (CSS px, world coords) ──────────────────────────────────────
// The board is rendered as a PCB-style frame with the LTDC display centred and
// 24 GPIO header pins (12 top + 12 bottom) along the long edges. Pin coords
// match what `PinOverlay` reads from `pinInfo`, so the click-target and the
// visible gold pad always line up.
const FRAME_W = 470;
const FRAME_H = 348;
const SCREEN_W = 410;        // 1024 × 0.4 — natural CSS size of the LTDC panel
const SCREEN_H = 240;        // 600  × 0.4
const SCREEN_X = (FRAME_W - SCREEN_W) / 2; // 30 — equal padding L/R
const SCREEN_Y = 58;         // leaves room for title + top pin row
const TOP_PIN_Y = 37;
const BOT_PIN_Y = 311;
const PIN_X = (i: number): number => Math.round(SCREEN_X + 17 + i * 34);

interface Stm32PinSignal {
  type: string;
  signal?: string;
  voltage?: number;
}

interface Stm32PinDef {
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
export const STM32H7_PINS: Stm32PinDef[] = [
  // ── Top row ────────────────────────────────────────────────────────────
  { name: '3V3',   x: PIN_X(0),  y: TOP_PIN_Y, signals: [{ type: 'power', signal: 'VCC', voltage: 3.3 }] },
  { name: 'GND.1', x: PIN_X(1),  y: TOP_PIN_Y, signals: [{ type: 'power', signal: 'GND' }] },
  { name: 'PA9',   x: PIN_X(2),  y: TOP_PIN_Y, signals: [{ type: 'usart', signal: 'TX' }],  description: 'USART1 TX (REPL)' },
  { name: 'PA10',  x: PIN_X(3),  y: TOP_PIN_Y, signals: [{ type: 'usart', signal: 'RX' }],  description: 'USART1 RX (REPL)' },
  { name: 'PA0',   x: PIN_X(4),  y: TOP_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC1_INP16' },
  { name: 'PA3',   x: PIN_X(5),  y: TOP_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC1_INP15' },
  { name: 'PA4',   x: PIN_X(6),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'NSS' }],   description: 'SPI1 NSS' },
  { name: 'PA5',   x: PIN_X(7),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'SCK' }],   description: 'SPI1 SCK' },
  { name: 'PA6',   x: PIN_X(8),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'MISO' }],  description: 'SPI1 MISO' },
  { name: 'PA7',   x: PIN_X(9),  y: TOP_PIN_Y, signals: [{ type: 'spi', signal: 'MOSI' }],  description: 'SPI1 MOSI' },
  { name: 'PB7',   x: PIN_X(10), y: TOP_PIN_Y, signals: [] },
  { name: 'PB15',  x: PIN_X(11), y: TOP_PIN_Y, signals: [] },
  // ── Bottom row ─────────────────────────────────────────────────────────
  { name: '5V',    x: PIN_X(0),  y: BOT_PIN_Y, signals: [{ type: 'power', signal: 'VCC', voltage: 5 }] },
  { name: 'GND.2', x: PIN_X(1),  y: BOT_PIN_Y, signals: [{ type: 'power', signal: 'GND' }] },
  { name: 'PB8',   x: PIN_X(2),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SCL' }],   description: 'I2C1 SCL' },
  { name: 'PB9',   x: PIN_X(3),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SDA' }],   description: 'I2C1 SDA' },
  { name: 'PB10',  x: PIN_X(4),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SCL' }],   description: 'I2C2 SCL' },
  { name: 'PB11',  x: PIN_X(5),  y: BOT_PIN_Y, signals: [{ type: 'i2c', signal: 'SDA' }],   description: 'I2C2 SDA' },
  { name: 'PC0',   x: PIN_X(6),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP10' },
  { name: 'PC1',   x: PIN_X(7),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP11' },
  { name: 'PC2',   x: PIN_X(8),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP12' },
  { name: 'PC3',   x: PIN_X(9),  y: BOT_PIN_Y, signals: [{ type: 'analog' }],               description: 'ADC123_INP13' },
  { name: 'PC13',  x: PIN_X(10), y: BOT_PIN_Y, signals: [] },
  { name: 'PC14',  x: PIN_X(11), y: BOT_PIN_Y, signals: [] },
];

interface Stm32H7DisplayProps {
  id: string;
  x: number;
  y: number;
}

export const Stm32H7Display = ({ id, x, y }: Stm32H7DisplayProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [framebuffer, setFramebuffer] = useState<Stm32Framebuffer | null>(null);
  // On-board LEDs (PB0 = red, PB1 = green) — wired in stm32h7_core_v13.repl
  // and lit by gpio_change events forwarded over the bridge. They give an
  // immediately visible signal that the GPIO transport is alive without
  // requiring the user to drag/wire any external component.
  const [ledRed, setLedRed] = useState(false);
  const [ledGreen, setLedGreen] = useState(false);

  // Expose pinInfo on the wrapper DOM node — PinOverlay discovers pins by
  // doing `document.getElementById(componentId).pinInfo`, mirroring how
  // wokwi LitElement boards advertise their pin map.
  useEffect(() => {
    if (wrapperRef.current) {
      (wrapperRef.current as unknown as { pinInfo: Stm32PinDef[] }).pinInfo = STM32H7_PINS;
    }
  }, []);

  // Subscribe to framebuffer + GPIO events from the active Stm32H7Bridge.
  // GPIO uses addGpioListener so the store's PinManager forwarder isn't
  // clobbered by us (and vice-versa). Framebuffer still uses the single
  // slot — only one consumer renders the LTDC canvas anyway.
  useEffect(() => {
    const bridge = getStm32Bridge(id);
    if (!bridge) return;
    const prevFb = bridge.onFramebuffer;
    bridge.onFramebuffer = (fb) => {
      setFramebuffer(fb);
      prevFb?.(fb);
    };
    const unsubGpio = bridge.addGpioListener((port, pin, value) => {
      if (port === 'B' && pin === 0) setLedRed(value);
      else if (port === 'B' && pin === 1) setLedGreen(value);
    });
    return () => {
      if (bridge.onFramebuffer && bridge.onFramebuffer !== prevFb) {
        bridge.onFramebuffer = prevFb;
      }
      unsubGpio();
    };
  }, [id]);

  // Repaint canvas whenever a new framebuffer arrives.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!framebuffer) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const { width, height, pitch, format, bytes } = framebuffer;
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const rgba = decodeFramebufferToRGBA(bytes, width, height, pitch, format);
    if (!rgba) return;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  }, [framebuffer]);

  return (
    <div
      id={id}
      ref={wrapperRef}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: FRAME_W,
        height: FRAME_H,
        background: 'linear-gradient(180deg, #0e2d1c 0%, #0a1f12 100%)',
        border: '2px solid #051a0c',
        borderRadius: 6,
        boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      {/* Silkscreen title */}
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 0,
          right: 0,
          textAlign: 'center',
          color: '#9ec9a8',
          fontSize: 9,
          fontFamily: 'monospace',
          letterSpacing: 1.6,
          userSelect: 'none',
        }}
      >
        STM32H7 CORE V13
      </div>

      {/* On-board LEDs (PB0 red, PB1 green) — driven by stm32_gpio_change */}
      <BoardLed x={FRAME_W - 32} y={6} color="#e02628" on={ledRed}   label="PB0" />
      <BoardLed x={FRAME_W - 16} y={6} color="#22c55e" on={ledGreen} label="PB1" />

      {/* LTDC display */}
      <div
        style={{
          position: 'absolute',
          left: SCREEN_X,
          top: SCREEN_Y,
          width: SCREEN_W,
          height: SCREEN_H,
          background: '#000',
          border: '1px solid #2a4a32',
          borderRadius: 2,
          overflow: 'hidden',
          // Enable pointer events on the screen alone — the parent has
          // pointerEvents: 'none' so the rest of the PCB silkscreen
          // doesn't intercept canvas drags. Touch is forwarded to the
          // backend's mailbox at 0x60000000 (see Stm32H7Bridge.sendTouch).
          pointerEvents: 'auto',
          cursor: 'crosshair',
        }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          forwardTouch(id, e, framebuffer, true);
        }}
        onPointerMove={(e) => {
          // Only forward while the mouse button is held — LVGL's pointer
          // indev handles "released" position from the last `state` we sent.
          if (e.buttons === 0) return;
          forwardTouch(id, e, framebuffer, true);
        }}
        onPointerUp={(e) => {
          (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          forwardTouch(id, e, framebuffer, false);
        }}
        onPointerCancel={(e) => {
          // Browser-level cancellation (e.g. system gesture) — release.
          forwardTouch(id, e, framebuffer, false);
        }}
      >
        <canvas
          ref={canvasRef}
          width={framebuffer?.width ?? 1024}
          height={framebuffer?.height ?? 600}
          style={{
            width: '100%',
            height: '100%',
            imageRendering: 'pixelated',
            display: 'block',
          }}
        />
      </div>

      {/* Pin pads + labels */}
      {STM32H7_PINS.map((pin) => {
        const isTop = pin.y < SCREEN_Y;
        const labelTop = isTop ? pin.y - 21 : pin.y + 9;
        return (
          <React.Fragment key={pin.name}>
            <div
              style={{
                position: 'absolute',
                left: pin.x - 7,
                top: pin.y - 7,
                width: 14,
                height: 14,
                borderRadius: 2,
                background:
                  'radial-gradient(ellipse at 30% 30%, #f0d178 0%, #b08828 60%, #6e5414 100%)',
                border: '1px solid #3d2c08',
                boxShadow: 'inset 0 0 2px rgba(0,0,0,0.4)',
                pointerEvents: 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: pin.x - 30,
                top: labelTop,
                width: 60,
                textAlign: 'center',
                color: '#d6e9da',
                fontSize: 8,
                fontFamily: 'monospace',
                letterSpacing: 0.2,
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            >
              {pin.name.replace(/\.\d+$/, '')}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

interface BoardLedProps {
  x: number;
  y: number;
  color: string;
  on: boolean;
  label: string;
}

const BoardLed = ({ x, y, color, on, label }: BoardLedProps) => (
  <div
    title={`${label} ${on ? 'ON' : 'OFF'}`}
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: on ? color : '#1a1a1a',
      border: `1px solid ${on ? color : '#333'}`,
      boxShadow: on ? `0 0 6px 1px ${color}` : 'none',
      transition: 'background 0.08s, box-shadow 0.08s',
      pointerEvents: 'none',
    }}
  />
);

// Throttle table for `forwardTouch` so a fast drag doesn't flood the
// backend monitor with WriteDoubleWord commands. ~30 Hz is enough for a
// fluid LVGL indev experience, and we always pass through state changes
// (press / release) immediately regardless of throttle.
const TOUCH_THROTTLE_MS = 33;
const _lastTouchAt: Record<string, number> = {};

function forwardTouch(
  boardId: string,
  e: React.PointerEvent<HTMLDivElement>,
  framebuffer: Stm32Framebuffer | null,
  pressed: boolean,
): void {
  const fbW = framebuffer?.width  ?? 1024;
  const fbH = framebuffer?.height ?? 600;
  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  let x = ((e.clientX - rect.left) / rect.width)  * fbW;
  let y = ((e.clientY - rect.top)  / rect.height) * fbH;
  x = Math.max(0, Math.min(fbW - 1, x));
  y = Math.max(0, Math.min(fbH - 1, y));

  const key = boardId;
  const now = performance.now();
  const last = _lastTouchAt[key] ?? 0;
  // Always send transitions; throttle continuous drags.
  if (pressed && (now - last) < TOUCH_THROTTLE_MS) return;
  _lastTouchAt[key] = now;

  const bridge = getStm32Bridge(boardId);
  bridge?.sendTouch(x, y, pressed);
}

function decodeFramebufferToRGBA(
  src: Uint8Array,
  width: number,
  height: number,
  pitch: number,
  format: Stm32PixelFormat,
): Uint8ClampedArray | null {
  const out = new Uint8ClampedArray(width * height * 4);
  switch (format) {
    case 'rgb565': {
      for (let row = 0; row < height; row++) {
        const sOff = row * pitch;
        const dOff = row * width * 4;
        for (let col = 0; col < width; col++) {
          const lo = src[sOff + col * 2];
          const hi = src[sOff + col * 2 + 1];
          if (lo === undefined || hi === undefined) return null;
          const v = (hi << 8) | lo;
          const r = (v >> 11) & 0x1f;
          const g = (v >>  5) & 0x3f;
          const b =  v        & 0x1f;
          const o = dOff + col * 4;
          out[o    ] = (r << 3) | (r >> 2);
          out[o + 1] = (g << 2) | (g >> 4);
          out[o + 2] = (b << 3) | (b >> 2);
          out[o + 3] = 0xff;
        }
      }
      return out;
    }
    case 'rgb888': {
      for (let row = 0; row < height; row++) {
        const sOff = row * pitch;
        const dOff = row * width * 4;
        for (let col = 0; col < width; col++) {
          const o = dOff + col * 4;
          const s = sOff + col * 3;
          out[o    ] = src[s + 2] ?? 0;
          out[o + 1] = src[s + 1] ?? 0;
          out[o + 2] = src[s    ] ?? 0;
          out[o + 3] = 0xff;
        }
      }
      return out;
    }
    case 'argb8888': {
      for (let row = 0; row < height; row++) {
        const sOff = row * pitch;
        const dOff = row * width * 4;
        for (let col = 0; col < width; col++) {
          const o = dOff + col * 4;
          const s = sOff + col * 4;
          out[o    ] = src[s + 2] ?? 0;
          out[o + 1] = src[s + 1] ?? 0;
          out[o + 2] = src[s    ] ?? 0;
          out[o + 3] = src[s + 3] ?? 0xff;
        }
      }
      return out;
    }
    default:
      return null;
  }
}
