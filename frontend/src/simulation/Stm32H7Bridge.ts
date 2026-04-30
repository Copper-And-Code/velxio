/**
 * Stm32H7Bridge
 *
 * WebSocket connection from frontend to backend RenodeManager
 * for one STM32H7_CORE V13 board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'start_stm32',        data: { board: 'stm32-h7-core-v13', firmware_path?: string } }
 *     { type: 'stop_stm32' }
 *     { type: 'stm32_serial_input', data: { bytes: number[] } }
 *     { type: 'stm32_gpio_input',   data: { port: 'A'..'H', pin: 0..15, value: bool } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output',     data: { data: string } }
 *     { type: 'system',            data: { event: string } }
 *     { type: 'error',             data: { message: string } }
 *     { type: 'framebuffer',       data: { width, height, pitch, format, bytes_b64 } }
 *     { type: 'stm32_gpio_change', data: { port: 'A'..'H', pin: 0..15, value: bool } }
 *
 * GPIO direction is one-shot per pin: outputs are observed by polling each
 * GPIOx_ODR register on the backend (see RenodeManager._poll_gpio_loop), so
 * fast PWM is not faithfully relayed — only logic-level transitions are.
 * Inputs are driven via Renode's BaseGPIOPort.OnGPIO method.
 */

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
  format: Stm32PixelFormat;
  bytes: Uint8Array;    // raw, in `format`, length === pitch * height
}

const API_BASE = (): string =>
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

export class Stm32H7Bridge {
  readonly boardId: string;

  onSerialData: ((char: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  onFramebuffer: ((fb: Stm32Framebuffer) => void) | null = null;

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

  // ── Raw-paste REPL injection (lv_micropython on STM32H7) ─────────────────
  // Same 3-stage handshake as Esp32Bridge: wait for the friendly REPL banner,
  // poke the UART to flush ">>> ", drop into raw REPL with Ctrl+A, then push
  // the user's main.py and Ctrl+D to compile + execute. The board's flash
  // filesystem is not mountable in Renode (no QSPI image), so this is the
  // only way to get user code running short of rebuilding the firmware.
  private _pendingMicroPythonCode: string | null = null;
  private _serialBuffer = '';
  private _replState: 'idle' | 'banner_seen' | 'prompt_seen' | 'raw_repl_entered' = 'idle';

  constructor(boardId: string, firmwarePath: string | null = null) {
    this.boardId = boardId;
    this.firmwarePath = firmwarePath;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Queue user MicroPython code for injection after the REPL boots.
   * The state machine in onmessage will push it via raw REPL once it sees
   * the banner. Call this BEFORE connect() (or before reset) so the bridge
   * is armed when the first banner bytes arrive.
   */
  setPendingMicroPythonCode(code: string): void {
    this._pendingMicroPythonCode = code;
    this._serialBuffer = '';
    this._replState = 'idle';
  }

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    const base = API_BASE();
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const wsUrl =
      base.replace(/^https?:/, wsProtocol) +
      `/simulation/ws/${encodeURIComponent(this.boardId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      this.onConnected?.();
      const startData: Record<string, unknown> = { board: 'stm32-h7-core-v13' };
      if (this.firmwarePath) startData.firmware_path = this.firmwarePath;
      this._send({ type: 'start_stm32', data: startData });
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
          if (this.onSerialData) {
            for (const ch of text) this.onSerialData(ch);
          }
          // MicroPython REPL injection — 3-stage state machine. Each stage
          // waits for a confirmed substring in the buffered serial output
          // before advancing, so we never push code before raw REPL is up.
          if (this._pendingMicroPythonCode || this._replState !== 'idle') {
            this._serialBuffer += text;

            // Stage 1: friendly REPL banner → poke with \r so the ">>> "
            // prompt (which has no trailing \n) is flushed out of Renode's
            // UART buffer.
            if (
              this._replState === 'idle' &&
              this._serialBuffer.includes('Type "help()"')
            ) {
              this._replState = 'banner_seen';
              setTimeout(() => this.sendSerialBytes([0x0d]), 800);
            }

            // Stage 2: ">>>" prompt seen → Ctrl+A enters raw REPL.
            if (
              this._replState === 'banner_seen' &&
              this._serialBuffer.includes('>>>')
            ) {
              this._replState = 'prompt_seen';
              this._serialBuffer = '';
              setTimeout(() => this.sendSerialBytes([0x01]), 200);
            }

            // Stage 3: "raw REPL" confirmation → safe to push code + Ctrl+D.
            if (
              this._replState === 'prompt_seen' &&
              this._serialBuffer.includes('raw REPL')
            ) {
              this._replState = 'raw_repl_entered';
              const code = this._pendingMicroPythonCode!;
              this._pendingMicroPythonCode = null;
              this._serialBuffer = '';
              setTimeout(() => this._sendCodeInRawRepl(code), 200);
            }

            // Bound the buffer in case something never matches.
            if (this._serialBuffer.length > 8192) {
              this._serialBuffer = this._serialBuffer.slice(-1024);
            }
          }
          break;
        }
        case 'system':
          this.onSystemEvent?.(msg.data.event as string, msg.data);
          break;
        case 'error':
          this.onError?.(msg.data.message as string);
          break;
        case 'stm32_gpio_change': {
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
          const b64 = (msg.data.bytes_b64 as string) ?? '';
          if (!b64) break;
          let bytes: Uint8Array;
          try {
            const bin = atob(b64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } catch {
            break;
          }
          this.onFramebuffer({
            width:  Number(msg.data.width)  | 0,
            height: Number(msg.data.height) | 0,
            pitch:  Number(msg.data.pitch)  | 0,
            format: (msg.data.format as Stm32PixelFormat) ?? 'rgb565',
            bytes,
          });
          break;
        }
      }
    };

    socket.onclose = () => {
      this._connected = false;
      this.socket = null;
      this.onDisconnected?.();
    };

    socket.onerror = () => {
      this.onError?.('WebSocket error');
    };
  }

  disconnect(): void {
    if (this.socket) {
      this._send({ type: 'stop_stm32' });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
  }

  sendSerialByte(byte: number): void {
    this._send({ type: 'stm32_serial_input', data: { bytes: [byte] } });
  }

  sendSerialBytes(bytes: number[]): void {
    if (bytes.length === 0) return;
    this._send({ type: 'stm32_serial_input', data: { bytes } });
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
      type: 'stm32_gpio_input',
      data: { port: p, pin, value },
    });
  }

  /**
   * Strip non-ASCII from comments and normalise line endings so the
   * MicroPython tokenizer doesn't choke (same caveats as ESP32: no wide
   * unicode in identifiers/literals on these MCU builds).
   */
  private static _sanitizeForRepl(code: string): string {
    let s = code.startsWith('﻿') ? code.slice(1) : code;
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = s.replace(/^([ \t]*#.*)$/gm, (line) => line.replace(/[^\x00-\x7F]/g, '?'));
    s = s.replace(/([ \t]+#.*)$/gm, (c) => c.replace(/[^\x00-\x7F]/g, '?'));
    return s;
  }

  /**
   * Push the user code through raw REPL. The Renode UART has no FIFO
   * back-pressure problem (it's a software TCP socket), but we still chunk
   * + space the writes so the lv_micropython tokenizer/parser can keep up
   * on a 480 MHz emulated H7 — Renode runs roughly 10× slower than wall
   * clock here, and a 50 KB script in one shot can starve the REPL task.
   */
  private _sendCodeInRawRepl(code: string): void {
    const sanitized = Stm32H7Bridge._sanitizeForRepl(code);
    const codeBytes = Array.from(new TextEncoder().encode(sanitized));
    const CHUNK_SIZE = 128;
    const CHUNK_DELAY_MS = 60;
    let offset = 0;

    const sendChunk = () => {
      if (offset >= codeBytes.length) {
        setTimeout(() => {
          this.sendSerialBytes([0x04]); // Ctrl+D → compile & execute
          this._replState = 'idle';
        }, 200);
        return;
      }
      this.sendSerialBytes(codeBytes.slice(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE;
      setTimeout(sendChunk, CHUNK_DELAY_MS);
    };
    sendChunk();
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
