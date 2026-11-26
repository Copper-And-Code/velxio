import React, { useEffect, useRef, useState } from 'react';
import type {
  Stm32DisplayStats,
  Stm32Framebuffer,
  Stm32FramebufferPatch,
  Stm32PixelFormat,
} from '../../simulation/Stm32H7Bridge';
import { getStm32H7Bridge } from '../../store/useSimulatorStore';
import {
  FRAME_H,
  FRAME_W,
  SCREEN_H,
  SCREEN_W,
  SCREEN_X,
  SCREEN_Y,
  STM32H7_PINS,
  type Stm32PinDef,
} from '../../simulation/stm32h7Pins';

export { STM32H7_PINS };

const PCB_GREEN = '#0d3a24';
const PCB_DARK = '#082516';
const SILK = '#d7eadc';
const COPPER = '#c49b37';
const DISPLAY_STATS_STORAGE_KEY = 'velxio:stm32-display-stats';


interface Stm32H7DisplayProps {
  id: string;
  x: number;
  y: number;
}

export const Stm32H7Display = ({ id, x, y }: Stm32H7DisplayProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framebufferRef = useRef<Stm32Framebuffer | null>(null);
  const patchQueueRef = useRef<Stm32FramebufferPatch[]>([]);
  const patchRafRef = useRef<number | null>(null);
  const [framebuffer, setFramebuffer] = useState<Stm32Framebuffer | null>(null);
  const [displayStats, setDisplayStats] = useState<Stm32DisplayStats | null>(null);
  const [showDisplayStats, setShowDisplayStats] = useState(readDisplayStatsPreference);
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

  useEffect(() => {
    writeDisplayStatsPreference(showDisplayStats);
  }, [showDisplayStats]);

  // Subscribe to framebuffer + GPIO events from the active Stm32H7Bridge.
  // GPIO uses addGpioListener so the store's PinManager forwarder isn't
  // clobbered by us (and vice-versa). Framebuffer still uses the single
  // slot — only one consumer renders the LTDC canvas anyway.
  useEffect(() => {
    const bridge = getStm32H7Bridge(id);
    if (!bridge) return;
    const drainPatchQueue = () => {
      patchRafRef.current = null;
      const canvas = canvasRef.current;
      const patches = patchQueueRef.current.splice(0);
      for (const patch of patches) {
        framebufferRef.current = patch;
        paintFramebufferPatch(canvas, patch);
      }
    };
    const schedulePatchPaint = () => {
      if (patchRafRef.current !== null) return;
      patchRafRef.current = window.requestAnimationFrame(drainPatchQueue);
    };
    const prevFb = bridge.onFramebuffer;
    const prevPatch = bridge.onFramebufferPatch;
    const prevStats = bridge.onDisplayStats;
    bridge.onFramebuffer = (fb) => {
      patchQueueRef.current = [];
      if (patchRafRef.current !== null) {
        window.cancelAnimationFrame(patchRafRef.current);
        patchRafRef.current = null;
      }
      framebufferRef.current = fb;
      setFramebuffer(fb);
      prevFb?.(fb);
    };
    bridge.onFramebufferPatch = (patch) => {
      patchQueueRef.current.push(patch);
      schedulePatchPaint();
      prevPatch?.(patch);
    };
    bridge.onDisplayStats = (stats) => {
      setDisplayStats(stats);
      prevStats?.(stats);
    };
    const unsubGpio = bridge.addGpioListener((port, pin, value) => {
      if (port === 'B' && pin === 0) setLedRed(value);
      else if (port === 'B' && pin === 1) setLedGreen(value);
    });
    return () => {
      if (bridge.onFramebuffer && bridge.onFramebuffer !== prevFb) {
        bridge.onFramebuffer = prevFb;
      }
      if (bridge.onFramebufferPatch && bridge.onFramebufferPatch !== prevPatch) {
        bridge.onFramebufferPatch = prevPatch;
      }
      if (bridge.onDisplayStats && bridge.onDisplayStats !== prevStats) {
        bridge.onDisplayStats = prevStats;
      }
      if (patchRafRef.current !== null) {
        window.cancelAnimationFrame(patchRafRef.current);
        patchRafRef.current = null;
      }
      patchQueueRef.current = [];
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
        background:
          `linear-gradient(180deg, ${PCB_GREEN} 0%, ${PCB_DARK} 100%)`,
        border: '2px solid #04180e',
        borderRadius: 8,
        boxShadow:
          '0 8px 20px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.05)',
        pointerEvents: 'none',
        zIndex: 1,
        overflow: 'hidden',
      }}
    >
      <PcbTexture />
      <MountingHole x={12} y={12} />
      <MountingHole x={FRAME_W - 24} y={12} />
      <MountingHole x={12} y={FRAME_H - 24} />
      <MountingHole x={FRAME_W - 24} y={FRAME_H - 24} />

      {/* Silkscreen title */}
      <div
        style={{
          position: 'absolute',
          top: 7,
          left: 0,
          right: 0,
          textAlign: 'center',
          color: SILK,
          fontSize: 10,
          fontFamily: 'monospace',
          fontWeight: 700,
          letterSpacing: 0.8,
          userSelect: 'none',
        }}
      >
        STM32H743 CORE V13
      </div>
      <div
        style={{
          position: 'absolute',
          top: 21,
          left: 0,
          right: 0,
          textAlign: 'center',
          color: '#8fbaa0',
          fontSize: 7,
          fontFamily: 'monospace',
          letterSpacing: 0.2,
          userSelect: 'none',
        }}
      >
        32MB SDRAM · LTDC RGB · LVGL MicroPython
      </div>

      {/* On-board LEDs (PB0 red, PB1 green) — driven by stm32h7_gpio_change */}
      <BoardLed x={FRAME_W - 42} y={12} color="#e02628" on={ledRed} label="PB0" />
      <BoardLed x={FRAME_W - 22} y={12} color="#22c55e" on={ledGreen} label="PB1" />

      <UsbConnector x={12} y={142} />

      {/* LTDC display */}
      <div
        style={{
          position: 'absolute',
          left: SCREEN_X - 6,
          top: SCREEN_Y - 6,
          width: SCREEN_W + 12,
          height: SCREEN_H + 12,
          background: 'linear-gradient(180deg, #242424 0%, #0d0d0d 100%)',
          border: '1px solid #334238',
          borderRadius: 5,
          boxShadow: '0 2px 9px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.06)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: SCREEN_X,
          top: SCREEN_Y,
          width: SCREEN_W,
          height: SCREEN_H,
          background: '#050505',
          border: '1px solid #050505',
          borderRadius: 3,
          overflow: 'hidden',
          // Enable pointer events on the screen alone — the parent has
          // pointerEvents: 'none' so the rest of the PCB silkscreen
          // doesn't intercept canvas drags. Touch is forwarded to the
          // backend's mailbox at 0x3800FF00 (see Stm32H7Bridge.sendTouch).
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
            imageRendering: 'auto',
            display: 'block',
          }}
        />
        {!framebuffer && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#36463d',
              fontSize: 11,
              fontFamily: 'monospace',
              letterSpacing: 0.6,
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            LTDC
          </div>
        )}
        {displayStats && showDisplayStats && <DisplayStatsOverlay stats={displayStats} />}
      </div>
      <button
        type="button"
        title={showDisplayStats ? 'Hide LTDC render stats' : 'Show LTDC render stats'}
        onClick={(e) => {
          e.stopPropagation();
          setShowDisplayStats((visible) => !visible);
        }}
        style={{
          position: 'absolute',
          right: 70,
          top: 13,
          width: 31,
          height: 14,
          border: '1px solid rgba(215, 234, 220, 0.28)',
          borderRadius: 3,
          background: showDisplayStats ? 'rgba(16, 75, 45, 0.9)' : 'rgba(8, 21, 13, 0.8)',
          color: showDisplayStats ? '#c7f0d4' : '#78907f',
          fontSize: 7,
          fontFamily: 'monospace',
          lineHeight: '12px',
          padding: 0,
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 4,
        }}
      >
        stats
      </button>
      {/* Pin pads + labels */}
      {STM32H7_PINS.map((pin) => {
        const isTop = pin.y < SCREEN_Y;
        const labelTop = isTop ? pin.y + 9 : pin.y + 9;
        const powerPin = pin.signals.some((s) => s.type === 'power');
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
                  powerPin
                    ? 'radial-gradient(ellipse at 30% 30%, #ffe5a0 0%, #d6a73c 58%, #805c15 100%)'
                    : `radial-gradient(ellipse at 30% 30%, #f0d178 0%, ${COPPER} 60%, #6e5414 100%)`,
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
                color: powerPin ? '#ffe7a3' : SILK,
                fontSize: 8,
                fontFamily: 'monospace',
                fontWeight: powerPin ? 700 : 500,
                letterSpacing: 0,
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

const PcbTexture = () => (
  <>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 18px), repeating-linear-gradient(0deg, rgba(0,0,0,0.08) 0 1px, transparent 1px 22px)',
        opacity: 0.45,
        pointerEvents: 'none',
      }}
    />
    {Array.from({ length: 10 }, (_, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: 72 + i * 34,
          top: 51,
          width: 1,
          height: 18,
          background: 'rgba(202, 236, 212, 0.18)',
          pointerEvents: 'none',
        }}
      />
    ))}
  </>
);

const MountingHole = ({ x, y }: { x: number; y: number }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: '#06130c',
      border: '2px solid #b9c9bc',
      boxShadow: 'inset 0 0 4px rgba(0,0,0,0.8)',
      pointerEvents: 'none',
    }}
  />
);

const UsbConnector = ({ x, y }: { x: number; y: number }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: 18,
      height: 50,
      borderRadius: 3,
      background: 'linear-gradient(90deg, #b9bec1 0%, #747b80 100%)',
      border: '1px solid #4b5256',
      boxShadow: '0 2px 5px rgba(0,0,0,0.5), inset 0 0 0 2px rgba(255,255,255,0.18)',
      pointerEvents: 'none',
    }}
    title="USB"
  >
    <div
      style={{
        position: 'absolute',
        left: 4,
        top: 13,
        width: 8,
        height: 24,
        background: '#202428',
        borderRadius: 2,
      }}
    />
  </div>
);

const DisplayStatsOverlay = ({ stats }: { stats: Stm32DisplayStats }) => {
  const kb = stats.bytesSent / 1024;
  const changed = stats.changedRows > 0 ? `${stats.changedRows}r` : 'idle';
  return (
    <div
      title="STM32H7 LTDC render telemetry"
      style={{
        position: 'absolute',
        left: 4,
        bottom: 4,
        display: 'grid',
        gridTemplateColumns: 'repeat(4, auto)',
        gap: '3px 7px',
        padding: '4px 5px',
        borderRadius: 3,
        background: 'rgba(0, 0, 0, 0.58)',
        color: '#c7f0d4',
        fontSize: 7,
        fontFamily: 'monospace',
        lineHeight: 1.15,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <span>poll {stats.polls}</span>
      <span>full {stats.fullFrames}</span>
      <span>patch {stats.patches}</span>
      <span>{changed}</span>
      <span>{kb.toFixed(kb >= 100 ? 0 : 1)}kB</span>
      <span>{stats.scanMs.toFixed(0)}ms</span>
      <span>{stats.pollMs.toFixed(0)}ms</span>
      <span>{stats.format}</span>
    </div>
  );
};

function readDisplayStatsPreference(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(DISPLAY_STATS_STORAGE_KEY) !== '0';
}

function writeDisplayStatsPreference(visible: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DISPLAY_STATS_STORAGE_KEY, visible ? '1' : '0');
}

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
  const fbW = framebuffer?.sourceWidth  ?? framebuffer?.width  ?? 1024;
  const fbH = framebuffer?.sourceHeight ?? framebuffer?.height ?? 600;
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

  const bridge = getStm32H7Bridge(boardId);
  bridge?.sendTouch(x, y, pressed);
}

function paintFramebufferPatch(
  canvas: HTMLCanvasElement | null,
  patch: Stm32FramebufferPatch,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { x, y, width, height, pitch, format, bytes } = patch;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return;
  if (canvas.width < x + width || canvas.height < y + height) return;
  const rgba = decodeFramebufferToRGBA(bytes, width, height, pitch, format);
  if (!rgba) return;
  ctx.putImageData(new ImageData(rgba, width, height), x, y);
}

function decodeFramebufferToRGBA(
  src: Uint8Array,
  width: number,
  height: number,
  pitch: number,
  format: Stm32PixelFormat,
): Uint8ClampedArray<ArrayBuffer> | null {
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
