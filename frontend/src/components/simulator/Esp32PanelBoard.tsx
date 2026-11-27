/**
 * ESP32-4848S040 on the canvas: a 4" 480x480 RGB panel board (ESP32-S3), running its
 * VELXIO firmware on our QEMU's esp32s3-picsimlab machine.
 *
 * The panel is the emulator's RGB display: the ESP32 bridge hands each new picture
 * (`framebuffer` events, RGB565) to `onPanelFramebuffer`, painted here on a canvas.
 * The screen is the touch: a pointer on it becomes the GT911's point, sent as a
 * sensor_update to the touch controller the backend attaches on I2C0 (GPIO19).
 */
import { useEffect, useRef } from 'react';
import { getEsp32Bridge } from '../../store/useSimulatorStore';
import { decodeFramebufferToRGBA } from '../../simulation/framebufferDecode';

export const PANEL_W = 480;
export const PANEL_H = 480;
/** The GT911's sensor record is keyed by its SDA pin (backend _BUILTIN_SENSORS). */
const TOUCH_PIN = 19;
const SCALE = 0.6;
const BEZEL = 18;
export const ESP32_PANEL_FRAME_W = Math.round(PANEL_W * SCALE) + 2 * BEZEL;
export const ESP32_PANEL_FRAME_H = Math.round(PANEL_H * SCALE) + 2 * BEZEL + 22;
const TOUCH_THROTTLE_MS = 33;

/** Pads PinOverlay reads: four free GPIOs (IO1, IO2, IO40, IO41: PWM-capable,
 *  for a robot's motors and sensors; which ones the real board's connectors
 *  break out is still to be checked), then the UART0 header (the REPL, GPIO43
 *  TX / GPIO44 RX), 3V3, GND. */
export const ESP32_PANEL_PINS = [
  ...['1', '2', '40', '41'].map((name, i) => ({
    name,
    x: 8,
    y: ESP32_PANEL_FRAME_H - 128 + i * 14,
    signals: [{ type: 'gpio', signal: 'IO' + name }],
  })),
  { name: '3V3', x: 8, y: ESP32_PANEL_FRAME_H - 58, signals: [{ type: 'power', signal: 'VCC', voltage: 3.3 }] },
  { name: '43', x: 8, y: ESP32_PANEL_FRAME_H - 44, signals: [{ type: 'uart', signal: 'TX' }] },
  { name: '44', x: 8, y: ESP32_PANEL_FRAME_H - 30, signals: [{ type: 'uart', signal: 'RX' }] },
  { name: 'GND', x: 8, y: ESP32_PANEL_FRAME_H - 16, signals: [{ type: 'power', signal: 'GND' }] },
];

interface Props {
  id: string;
  x: number;
  y: number;
}

export const Esp32PanelBoard = ({ id, x, y }: Props) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTouch = useRef(0);

  useEffect(() => {
    if (wrapperRef.current) {
      (wrapperRef.current as unknown as { pinInfo: typeof ESP32_PANEL_PINS }).pinInfo = ESP32_PANEL_PINS;
    }
  }, []);

  // The bridge exists once the board is on the canvas; poll briefly for it.
  useEffect(() => {
    let cancelled = false;
    let bridgeRef: ReturnType<typeof getEsp32Bridge> | undefined;
    const attach = () => {
      const bridge = getEsp32Bridge(id);
      if (!bridge) {
        if (!cancelled) window.setTimeout(attach, 200);
        return;
      }
      bridgeRef = bridge;
      bridge.onPanelFramebuffer = (fb) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        if (canvas.width !== fb.width || canvas.height !== fb.height) {
          canvas.width = fb.width;
          canvas.height = fb.height;
        }
        const rgba = decodeFramebufferToRGBA(fb.bytes, fb.width, fb.height, fb.pitch, fb.format);
        if (rgba) ctx.putImageData(new ImageData(rgba, fb.width, fb.height), 0, 0);
      };
    };
    attach();
    return () => {
      cancelled = true;
      if (bridgeRef) bridgeRef.onPanelFramebuffer = null;
    };
  }, [id]);

  const touch = (e: React.PointerEvent<HTMLCanvasElement>, pressed: boolean, move = false) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const now = performance.now();
    if (move && now - lastTouch.current < TOUCH_THROTTLE_MS) return;
    lastTouch.current = now;
    const tx = Math.max(0, Math.min(PANEL_W - 1, Math.round(((e.clientX - rect.left) / rect.width) * PANEL_W)));
    const ty = Math.max(0, Math.min(PANEL_H - 1, Math.round(((e.clientY - rect.top) / rect.height) * PANEL_H)));
    getEsp32Bridge(id)?.sendSensorUpdate(TOUCH_PIN, { x: tx, y: ty, pressed });
  };

  const screenW = Math.round(PANEL_W * SCALE);
  const screenH = Math.round(PANEL_H * SCALE);
  return (
    <div
      id={id}
      ref={wrapperRef}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: ESP32_PANEL_FRAME_W,
        height: ESP32_PANEL_FRAME_H,
        background: '#1b1d21',
        borderRadius: 10,
        border: '1px solid #3a3d44',
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
          color: '#c9ccd3',
          letterSpacing: 0.4,
        }}
      >
        ESP32-4848S040 · ESP32-S3 · 480×480
      </div>
      <canvas
        ref={canvasRef}
        width={PANEL_W}
        height={PANEL_H}
        style={{
          position: 'absolute',
          left: BEZEL,
          top: BEZEL + 8,
          width: screenW,
          height: screenH,
          background: '#000',
          borderRadius: 2,
          imageRendering: 'auto',
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
