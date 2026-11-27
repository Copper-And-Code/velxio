/**
 * Waveshare RP2350-Touch-LCD-4 on the canvas: RP2350B, 4" 480x480 RGB panel with
 * a GT911, running its VELXIO firmware on our QEMU's raspi-pico2 machine
 * (backend rp2350_qemu.py).
 *
 * The bridge is Stm32H7Bridge on the `rp2350_` lane: the same `framebuffer`
 * events (RGB565; 480x480 with the PSRAM Velxio fits, 240x240 shown 2x2 without).
 * The screen is the touch: a pointer on it becomes the GT911's point, in panel
 * coordinates (0-479).
 */
import { useEffect, useRef } from 'react';
import { getStm32H7Bridge } from '../../store/useSimulatorStore';
import { decodeFramebufferToRGBA } from '../../simulation/framebufferDecode';

export const RP2350_PANEL_W = 480;
export const RP2350_PANEL_H = 480;
const SCALE = 0.6;
const BEZEL = 18;
export const RP2350_PANEL_FRAME_W = Math.round(RP2350_PANEL_W * SCALE) + 2 * BEZEL;
export const RP2350_PANEL_FRAME_H = Math.round(RP2350_PANEL_H * SCALE) + 2 * BEZEL + 22;
const TOUCH_THROTTLE_MS = 33;

/** Pads PinOverlay reads: four GPIOs for a robot's motors and sensors (GP8,
 *  GP9: UART1 on the board, PWM slice 4; GP10, GP11: the TF slot's CLK and
 *  CMD, free without a card; which ones the real board's connectors break
 *  out is still to be checked), then the UART0 header (the REPL, GP46 TX /
 *  GP45 RX), 3V3, GND. */
export const RP2350_PANEL_PINS = [
  ...['GP8', 'GP9', 'GP10', 'GP11'].map((name, i) => ({
    name,
    x: 8,
    y: RP2350_PANEL_FRAME_H - 128 + i * 14,
    signals: [{ type: 'gpio', signal: name }],
  })),
  { name: '3V3', x: 8, y: RP2350_PANEL_FRAME_H - 58, signals: [{ type: 'power', signal: 'VCC', voltage: 3.3 }] },
  { name: 'GP46', x: 8, y: RP2350_PANEL_FRAME_H - 44, signals: [{ type: 'uart', signal: 'TX' }] },
  { name: 'GP45', x: 8, y: RP2350_PANEL_FRAME_H - 30, signals: [{ type: 'uart', signal: 'RX' }] },
  { name: 'GND', x: 8, y: RP2350_PANEL_FRAME_H - 16, signals: [{ type: 'power', signal: 'GND' }] },
];

interface Props {
  id: string;
  x: number;
  y: number;
}

export const Rp2350PanelBoard = ({ id, x, y }: Props) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTouch = useRef(0);

  useEffect(() => {
    if (wrapperRef.current) {
      (wrapperRef.current as unknown as { pinInfo: typeof RP2350_PANEL_PINS }).pinInfo = RP2350_PANEL_PINS;
    }
  }, []);

  // The bridge exists once the board is on the canvas; poll briefly for it.
  useEffect(() => {
    let cancelled = false;
    let bridgeRef: ReturnType<typeof getStm32H7Bridge> | undefined;
    let prev: NonNullable<ReturnType<typeof getStm32H7Bridge>>['onFramebuffer'] = null;
    const attach = () => {
      const bridge = getStm32H7Bridge(id);
      if (!bridge) {
        if (!cancelled) window.setTimeout(attach, 200);
        return;
      }
      bridgeRef = bridge;
      prev = bridge.onFramebuffer;
      bridge.onFramebuffer = (fb) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx) {
          if (canvas.width !== fb.width || canvas.height !== fb.height) {
            canvas.width = fb.width;
            canvas.height = fb.height;
          }
          const rgba = decodeFramebufferToRGBA(fb.bytes, fb.width, fb.height, fb.pitch, fb.format);
          if (rgba) ctx.putImageData(new ImageData(rgba, fb.width, fb.height), 0, 0);
        }
        prev?.(fb);
      };
    };
    attach();
    return () => {
      cancelled = true;
      if (bridgeRef) bridgeRef.onFramebuffer = prev;
    };
  }, [id]);

  const touch = (e: React.PointerEvent<HTMLCanvasElement>, pressed: boolean, move = false) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const now = performance.now();
    if (move && now - lastTouch.current < TOUCH_THROTTLE_MS) return;
    lastTouch.current = now;
    const tx = Math.max(0, Math.min(RP2350_PANEL_W - 1, Math.round(((e.clientX - rect.left) / rect.width) * RP2350_PANEL_W)));
    const ty = Math.max(0, Math.min(RP2350_PANEL_H - 1, Math.round(((e.clientY - rect.top) / rect.height) * RP2350_PANEL_H)));
    getStm32H7Bridge(id)?.sendTouch(tx, ty, pressed);
  };

  const screenW = Math.round(RP2350_PANEL_W * SCALE);
  const screenH = Math.round(RP2350_PANEL_H * SCALE);
  return (
    <div
      id={id}
      ref={wrapperRef}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: RP2350_PANEL_FRAME_W,
        height: RP2350_PANEL_FRAME_H,
        background: '#14261c',
        borderRadius: 10,
        border: '1px solid #2f4a3a',
        boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 0,
          right: 0,
          textAlign: 'center',
          font: '600 10px system-ui, sans-serif',
          color: '#c9d6cd',
          letterSpacing: 0.4,
        }}
      >
        RP2350-Touch-LCD-4 · RP2350B · 480×480
      </div>
      <canvas
        ref={canvasRef}
        width={240}
        height={240}
        style={{
          position: 'absolute',
          left: BEZEL,
          top: BEZEL + 8,
          width: screenW,
          height: screenH,
          background: '#000',
          borderRadius: 2,
          imageRendering: 'pixelated',
          pointerEvents: 'auto',
          cursor: 'crosshair',
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          touch(e, true);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) {
            e.stopPropagation();
            touch(e, true, true);
          }
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          touch(e, false);
        }}
        onPointerCancel={(e) => touch(e, false)}
      />
    </div>
  );
};
