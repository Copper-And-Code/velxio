/**
 * Stm32H7Bridge
 *
 * WebSocket connection from frontend to backend RenodeManager
 * for one STM32H7_CORE V13 board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'stm32h7_start',        data: { board: 'stm32h7-core-v13', firmware_path?: string } }
 *     { type: 'stm32h7_stop' }
 *     { type: 'stm32h7_serial_input', data: { bytes: number[] } }
 *     { type: 'stm32h7_gpio_input',   data: { port: 'A'..'H', pin: 0..15, value: bool } }
 *     { type: 'stm32h7_touch_input',  data: { x: int, y: int, pressed: bool } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output',     data: { data: string } }
 *     { type: 'system',            data: { event: string } }
 *     { type: 'error',             data: { message: string } }
 *     { type: 'framebuffer',       data: { width, height, pitch, source_width?, source_height?, format, bytes_b64 } }
 *     { type: 'framebuffer_patch', data: { x, y, width, height, pitch, source_width?, source_height?, format, bytes_b64 } }
 *     { type: 'display_stats',     data: { polls, unchanged, full_frames, patches, bytes_sent, changed_rows, scan_ms } }
 *     { type: 'stm32h7_gpio_change', data: { port: 'A'..'H', pin: 0..15, value: bool } }
 *
 * GPIO direction is one-shot per pin: outputs are observed by polling each
 * GPIOx_ODR register on the backend (see RenodeManager._poll_gpio_loop), so
 * fast PWM is not faithfully relayed — only logic-level transitions are.
 * Inputs are driven via Renode's BaseGPIOPort.OnGPIO method.
 */

import { getTabSessionId } from './Stm32Bridge';
import { MicroPythonSession, type MpyProgram } from './micropythonSession';

export type Stm32PixelFormat =
  | 'rgb565'
  | 'rgb888'
  | 'argb8888'
  | 'argb1555'
  | 'argb4444'
  | 'l8'
  | 'al44'
  | 'al88';

export interface Stm32Framebuffer {
  width: number;
  height: number;
  pitch: number;        // bytes per source line (may include padding)
  sourceWidth: number;  // real LTDC width; differs when backend sends a scaled preview
  sourceHeight: number; // real LTDC height; used for touch coordinate mapping
  sourcePitch?: number;
  scale?: number;
  format: Stm32PixelFormat;
  bytes: Uint8Array;    // raw, in `format`, length === pitch * height
}

export interface Stm32FramebufferPatch extends Stm32Framebuffer {
  x: number;
  y: number;
}

export interface Stm32DisplayStats {
  polls: number;
  unchanged: number;
  fullFrames: number;
  patches: number;
  bytesSent: number;
  changedRows: number;
  scanMs: number;
  pollMs: number;
  width: number;
  height: number;
  format: Stm32PixelFormat;
}

const API_BASE = (): string => {
  // Desktop shell: the sidecar URL injected at runtime (as in Stm32Bridge).
  if (typeof window !== 'undefined') {
    const injected = (window as { __VELXIO_API_BASE__?: string }).__VELXIO_API_BASE__;
    if (typeof injected === 'string' && injected) {
      return injected.replace(/\/+$/, '');
    }
  }
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';
};

export class Stm32H7Bridge {
  readonly boardId: string;

  onSerialData: ((char: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  onFramebuffer: ((fb: Stm32Framebuffer) => void) | null = null;
  onFramebufferPatch: ((patch: Stm32FramebufferPatch) => void) | null = null;
  onDisplayStats: ((stats: Stm32DisplayStats) => void) | null = null;

  // GPIO subscribers as a Set so multiple consumers (the store's PinManager
  // forwarder + Stm32H7Display's on-board LED mirror) can listen without
  // clobbering each other's slot. The legacy `onGpioChange` accessor is
  // kept so existing chained-prevGpio code in Stm32H7Display still works,
  // but it now wraps `addGpioListener` under the hood.
  private _gpioListeners = new Set<(port: string, pin: number, value: boolean) => void>();
  private _legacyOnGpio: ((port: string, pin: number, value: boolean) => void) | null = null;

  get onGpioChange():
    | ((port: string, pin: number, value: boolean) => void)
    | null {
    return this._legacyOnGpio;
  }
  set onGpioChange(
    cb: ((port: string, pin: number, value: boolean) => void) | null,
  ) {
    if (this._legacyOnGpio) this._gpioListeners.delete(this._legacyOnGpio);
    this._legacyOnGpio = cb;
    if (cb) this._gpioListeners.add(cb);
  }
  /** Add a GPIO listener that survives reassignment of `onGpioChange`. */
  addGpioListener(
    cb: (port: string, pin: number, value: boolean) => void,
  ): () => void {
    this._gpioListeners.add(cb);
    return () => { this._gpioListeners.delete(cb); };
  }

  private socket: WebSocket | null = null;
  private _connected = false;
  private firmwarePath: string | null = null;

  // ── Program upload (MicroPython on the STM32H7_CORE VELXIO firmware) ──────
  // The same session as the ESP32 bridges (simulation/micropythonSession.ts):
  // banner -> raw REPL -> each project file written onto /flash in bounded
  // steps -> the program started. /flash is the firmware's littlefs in RAM
  // (velxio_boot.py), since Renode cannot mount the QSPI flash.
  private _pendingProgram: MpyProgram | null = null;
  private _mpySession: MicroPythonSession | null = null;

  /**
   * The lane this bridge talks to. The STM32H743 Core in Renode by default;
   * the Waveshare RP2350-Touch-LCD-4 on our QEMU (backend rp2350_qemu.py)
   * speaks the same events with the `rp2350_` prefix.
   */
  private readonly prefix: string;
  private readonly boardKind: string;
  private readonly startExtras: Record<string, unknown>;

  constructor(
    boardId: string,
    firmwarePath: string | null = null,
    lane: { prefix?: string; board?: string; startData?: Record<string, unknown> } = {},
  ) {
    this.boardId = boardId;
    this.firmwarePath = firmwarePath;
    this.prefix = lane.prefix ?? 'stm32h7_';
    this.boardKind = lane.board ?? 'stm32h7-core-v13';
    this.startExtras = lane.startData ?? {};
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Queue a MicroPython project for the next boot: `files` are written onto
   * /flash, then `main` runs. Call it BEFORE connect(): the session follows the
   * boot banner of the instance connect() starts.
   */
  setPendingMicroPythonProgram(program: MpyProgram): void {
    this._pendingProgram = program;
    this._armSession();
  }

  /** A program with no other files. */
  setPendingMicroPythonCode(code: string): void {
    this.setPendingMicroPythonProgram({ files: [], main: code });
  }

  private _armSession(): void {
    this._mpySession?.dispose();
    this._mpySession = this._pendingProgram
      ? new MicroPythonSession((bytes) => this.sendSerialBytes(bytes), this._pendingProgram, {
          tag: `Stm32H7Bridge:${this.boardId}`,
          // Renode's UART, like QEMU's chardev, holds the prompt until
          // something else writes: the QEMU bridge's timings.
          pokeDelayMs: 800,
          stageDelayMs: 200,
          onNotice: (line) => {
            for (const ch of line) this.onSerialData?.(ch);
          },
        })
      : null;
  }

  private _disposeSession(): void {
    this._mpySession?.dispose();
    this._mpySession = null;
    this._pendingProgram = null;
  }

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    // A relative base ('/api', behind a proxy on the page's own origin, as in
    // Codespaces) is made absolute on the page's host and scheme.
    let base = API_BASE();
    if (base.startsWith('/') && typeof window !== 'undefined') base = window.location.origin + base;
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    // Same client id as the other backend bridges: two tabs with a board of
    // the same id must not share (and stop) one Renode instance.
    const wsUrl =
      base.replace(/^https?:/, wsProtocol) +
      `/simulation/ws/${encodeURIComponent(getTabSessionId() + '::' + this.boardId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      this.onConnected?.();
      const startData: Record<string, unknown> = { board: this.boardKind, ...this.startExtras };
      if (this.firmwarePath) startData.firmware_path = this.firmwarePath;
      this._send({ type: `${this.prefix}start`, data: startData });
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'serial_output': {
          const text = (msg.data.data as string) ?? '';
          // The session hides its own protocol chatter and passes the boot
          // banner and the program's output through.
          const shown = this._mpySession ? this._mpySession.feed(text) : text;
          if (this.onSerialData) {
            for (const ch of shown) this.onSerialData(ch);
          }
          break;
        }
        case 'system':
          this.onSystemEvent?.(msg.data.event as string, msg.data);
          break;
        case 'error':
          this.onError?.(msg.data.message as string);
          break;
        case `${this.prefix}gpio_change`: {
          const port = String(msg.data.port ?? '');
          const pin  = Number(msg.data.pin) | 0;
          const val  = Boolean(msg.data.value);
          if (port && pin >= 0 && pin < 16) {
            for (const cb of this._gpioListeners) cb(port, pin, val);
          }
          break;
        }
        case 'framebuffer': {
          if (!this.onFramebuffer) break;
          const fb = Stm32H7Bridge._parseFramebuffer(msg.data);
          if (fb) this.onFramebuffer(fb);
          break;
        }
        case 'framebuffer_patch': {
          if (!this.onFramebufferPatch) break;
          const fb = Stm32H7Bridge._parseFramebuffer(msg.data);
          if (!fb) break;
          this.onFramebufferPatch({
            x:      Number(msg.data.x)      | 0,
            y:      Number(msg.data.y)      | 0,
            ...fb,
          });
          break;
        }
        case 'display_stats': {
          this.onDisplayStats?.(Stm32H7Bridge._parseDisplayStats(msg.data));
          break;
        }
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this._connected = false;
      this.socket = null;
      this._disposeSession();
      this.onDisconnected?.();
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.onError?.('WebSocket error');
    };
  }

  disconnect(): void {
    if (this.socket) {
      this._send({ type: `${this.prefix}stop` });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
    this._disposeSession();
  }

  sendSerialByte(byte: number): void {
    this._send({ type: `${this.prefix}serial_input`, data: { bytes: [byte] } });
  }

  sendSerialBytes(bytes: number[]): void {
    if (bytes.length === 0) return;
    this._send({ type: `${this.prefix}serial_input`, data: { bytes } });
  }

  /**
   * Inject a touch event into the LTDC display.
   *
   * The backend writes (x, y, pressed) into a 16-byte "touch mailbox" at
   * `0x3800FF00` (top of the D3 SRAM). The firmware's touch driver
   * (velxio_touch.py, registered by `import display_driver`) polls it from
   * LVGL's indev read callback. Coordinates are in display pixel space (0..1023, 0..599),
   * so the caller is responsible for scaling from CSS / canvas-local
   * coordinates.
   *
   * The backend deduplicates redundant writes, but the frontend should
   * still throttle mouse-move bursts (e.g. via requestAnimationFrame or
   * a 30 Hz timer) to keep the Renode monitor lock contention low.
   */
  sendTouch(x: number, y: number, pressed: boolean): void {
    this._send({
      type: `${this.prefix}touch_input`,
      data: { x: Math.round(x), y: Math.round(y), pressed },
    });
  }

  /**
   * Drive a GPIO pin from the simulator (e.g. button press, sensor toggle).
   * Maps onto Renode's `gpioPort{X} OnGPIO {pin} {value}`. The firmware sees
   * this as if an external IC pulled the pin high or low.
   */
  setGpioInput(port: string, pin: number, value: boolean): void {
    const p = port.toUpperCase();
    if (p.length !== 1 || p < 'A' || p > 'H') return;
    if (!Number.isInteger(pin) || pin < 0 || pin > 15) return;
    this._send({
      type: `${this.prefix}gpio_input`,
      data: { port: p, pin, value },
    });
  }

  private static _decodeBase64Bytes(b64: string): Uint8Array | null {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }

  private static _parseFramebuffer(data: Record<string, unknown>): Stm32Framebuffer | null {
    const b64 = (data.bytes_b64 as string) ?? '';
    if (!b64) return null;
    const bytes = Stm32H7Bridge._decodeBase64Bytes(b64);
    if (!bytes) return null;
    return {
      width: Number(data.width) | 0,
      height: Number(data.height) | 0,
      pitch: Number(data.pitch) | 0,
      sourceWidth: Number(data.source_width ?? data.width) | 0,
      sourceHeight: Number(data.source_height ?? data.height) | 0,
      sourcePitch:
        data.source_pitch === undefined ? undefined : Number(data.source_pitch) | 0,
      scale: data.scale === undefined ? undefined : Number(data.scale) | 0,
      format: (data.format as Stm32PixelFormat) ?? 'rgb565',
      bytes,
    };
  }

  private static _parseDisplayStats(data: Record<string, unknown>): Stm32DisplayStats {
    return {
      polls: Number(data.polls) | 0,
      unchanged: Number(data.unchanged) | 0,
      fullFrames: Number(data.full_frames) | 0,
      patches: Number(data.patches) | 0,
      bytesSent: Number(data.bytes_sent) | 0,
      changedRows: Number(data.changed_rows) | 0,
      scanMs: Number(data.scan_ms) || 0,
      pollMs: Number(data.poll_ms) || 0,
      width: Number(data.width) | 0,
      height: Number(data.height) | 0,
      format: (data.format as Stm32PixelFormat) ?? 'rgb565',
    };
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
