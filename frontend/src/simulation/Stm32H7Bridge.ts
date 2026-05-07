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
 *     { type: 'stm32_touch_input',  data: { x: int, y: int, pressed: bool } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output',     data: { data: string } }
 *     { type: 'system',            data: { event: string } }
 *     { type: 'error',             data: { message: string } }
 *     { type: 'framebuffer',       data: { width, height, pitch, source_width?, source_height?, format, bytes_b64 } }
 *     { type: 'framebuffer_patch', data: { x, y, width, height, pitch, source_width?, source_height?, format, bytes_b64 } }
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

const API_BASE = (): string =>
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

const RAW_PASTE_CHUNK_SIZE = 512;
const RAW_PASTE_HANDSHAKE_TIMEOUT_MS = 2500;
const SERIAL_BUFFER_MAX = 8192;
const SERIAL_BUFFER_KEEP = 1024;

export class Stm32H7Bridge {
  readonly boardId: string;

  onSerialData: ((char: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  onFramebuffer: ((fb: Stm32Framebuffer) => void) | null = null;
  onFramebufferPatch: ((patch: Stm32FramebufferPatch) => void) | null = null;

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
  private _replState:
    | 'idle'
    | 'banner_seen'
    | 'prompt_seen'
    | 'raw_repl_entered'
    | 'raw_paste_starting'
    | 'raw_paste_sending' = 'idle';
  private _rawPasteBytes: number[] = [];
  private _rawPasteOffset = 0;
  private _rawPasteWindow = 0;
  private _rawPasteWindowSize = 0;
  private _rawPasteEofSent = false;
  private _rawPasteFallbackCode = '';
  private _rawPasteHandshakeTimer: number | null = null;
  private _replTimers: number[] = [];

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
    this._resetReplInjection();
    this._pendingMicroPythonCode = code;
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
          if (this._pendingMicroPythonCode || this._replState !== 'idle') {
            this._handleReplInjectionOutput(text);
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
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this._connected = false;
      this.socket = null;
      this._resetReplInjection();
      this.onDisconnected?.();
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
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
    this._resetReplInjection();
  }

  sendSerialByte(byte: number): void {
    this._send({ type: 'stm32_serial_input', data: { bytes: [byte] } });
  }

  sendSerialBytes(bytes: number[]): void {
    if (bytes.length === 0) return;
    this._send({ type: 'stm32_serial_input', data: { bytes } });
  }

  /**
   * Inject a touch event into the LTDC display.
   *
   * The backend writes (x, y, pressed) into a 16-byte "touch mailbox" at
   * `0xC1F00000` (near the top of SDRAM). A custom LVGL
   * indev driver in the user's MicroPython demo polls that mailbox via
   * `stm.mem32[]`. Coordinates are in display pixel space (0..1023, 0..599),
   * so the caller is responsible for scaling from CSS / canvas-local
   * coordinates.
   *
   * The backend deduplicates redundant writes, but the frontend should
   * still throttle mouse-move bursts (e.g. via requestAnimationFrame or
   * a 30 Hz timer) to keep the Renode monitor lock contention low.
   */
  sendTouch(x: number, y: number, pressed: boolean): void {
    this._send({
      type: 'stm32_touch_input',
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

  private _resetReplInjection(): void {
    if (this._rawPasteHandshakeTimer !== null) {
      clearTimeout(this._rawPasteHandshakeTimer);
      this._rawPasteHandshakeTimer = null;
    }
    for (const timer of this._replTimers) clearTimeout(timer);
    this._replTimers = [];
    this._pendingMicroPythonCode = null;
    this._serialBuffer = '';
    this._replState = 'idle';
    this._rawPasteBytes = [];
    this._rawPasteOffset = 0;
    this._rawPasteWindow = 0;
    this._rawPasteWindowSize = 0;
    this._rawPasteEofSent = false;
    this._rawPasteFallbackCode = '';
  }

  private _handleReplInjectionOutput(text: string): void {
    this._serialBuffer += text;

    if (this._replState === 'idle' && this._serialBuffer.includes('Type "help()"')) {
      this._replState = 'banner_seen';
      this._scheduleReplAction(() => this.sendSerialBytes([0x0d]), 800);
    }

    if (this._replState === 'banner_seen' && this._serialBuffer.includes('>>>')) {
      this._replState = 'prompt_seen';
      this._serialBuffer = '';
      this._scheduleReplAction(() => this.sendSerialBytes([0x01]), 200);
    }

    if (this._replState === 'prompt_seen' && this._serialBuffer.includes('raw REPL')) {
      this._replState = 'raw_repl_entered';
      const code = this._pendingMicroPythonCode;
      this._pendingMicroPythonCode = null;
      this._serialBuffer = '';
      if (code !== null) this._scheduleReplAction(() => this._startRawPaste(code), 200);
    }

    if (this._replState === 'raw_paste_starting') {
      this._handleRawPasteHandshake();
    } else if (this._replState === 'raw_paste_sending') {
      this._handleRawPasteAcks(text);
    }

    if (this._serialBuffer.length > SERIAL_BUFFER_MAX) {
      this._serialBuffer = this._serialBuffer.slice(-SERIAL_BUFFER_KEEP);
    }
  }

  private _handleRawPasteHandshake(): void {
    const supportedAt = this._serialBuffer.indexOf('R\x01');
    if (supportedAt >= 0 && this._serialBuffer.length >= supportedAt + 4) {
      if (this._rawPasteHandshakeTimer !== null) {
        clearTimeout(this._rawPasteHandshakeTimer);
        this._rawPasteHandshakeTimer = null;
      }
      this._rawPasteWindow =
        this._serialBuffer.charCodeAt(supportedAt + 2) |
        (this._serialBuffer.charCodeAt(supportedAt + 3) << 8);
      this._rawPasteWindowSize = this._rawPasteWindow || 128;
      this._serialBuffer = '';
      this._replState = 'raw_paste_sending';
      this._pumpRawPaste();
      return;
    }

    if (this._serialBuffer.includes('R\x00')) {
      this._fallbackFromRawPaste();
    }
  }

  private _handleRawPasteAcks(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const byte = text.charCodeAt(i) & 0xff;
      if (byte === 0x01) {
        this._rawPasteWindow += this._rawPasteWindowSize;
        this._pumpRawPaste();
      }
    }
  }

  private _fallbackFromRawPaste(): void {
    if (this._rawPasteHandshakeTimer !== null) {
      clearTimeout(this._rawPasteHandshakeTimer);
      this._rawPasteHandshakeTimer = null;
    }
    const code = this._rawPasteFallbackCode;
    this._serialBuffer = '';
    this._sendCodeInRawReplFallback(code);
  }

  private _scheduleReplAction(action: () => void, delayMs: number): void {
    const timer = window.setTimeout(() => {
      this._replTimers = this._replTimers.filter((id) => id !== timer);
      action();
    }, delayMs);
    this._replTimers.push(timer);
  }

  /**
   * Enter MicroPython raw-paste mode. Unlike plain raw REPL, this is
   * flow-controlled by the firmware using a small receive window, so large
   * scripts keep their indentation and line boundaries intact.
   */
  private _startRawPaste(code: string): void {
    const sanitized = Stm32H7Bridge._sanitizeForRepl(code);
    this._rawPasteBytes = Array.from(new TextEncoder().encode(sanitized));
    this._rawPasteOffset = 0;
    this._rawPasteWindow = 0;
    this._rawPasteWindowSize = 0;
    this._rawPasteEofSent = false;
    this._rawPasteFallbackCode = sanitized;
    this._serialBuffer = '';
    this._replState = 'raw_paste_starting';
    this.sendSerialBytes([0x05, 0x41, 0x01]);
    this._rawPasteHandshakeTimer = window.setTimeout(() => {
      if (this._replState === 'raw_paste_starting') this._fallbackFromRawPaste();
    }, RAW_PASTE_HANDSHAKE_TIMEOUT_MS);
  }

  private _pumpRawPaste(): void {
    if (this._replState !== 'raw_paste_sending') return;

    while (this._rawPasteWindow > 0 && this._rawPasteOffset < this._rawPasteBytes.length) {
      const count = Math.min(
        this._rawPasteWindow,
        RAW_PASTE_CHUNK_SIZE,
        this._rawPasteBytes.length - this._rawPasteOffset,
      );
      this.sendSerialBytes(
        this._rawPasteBytes.slice(this._rawPasteOffset, this._rawPasteOffset + count),
      );
      this._rawPasteOffset += count;
      this._rawPasteWindow -= count;
    }

    if (this._rawPasteOffset >= this._rawPasteBytes.length && !this._rawPasteEofSent) {
      this._rawPasteEofSent = true;
      this.sendSerialBytes([0x04]);
      this._replState = 'idle';
    }
  }

  /**
   * Fallback for MicroPython builds without raw-paste support.
   */
  private _sendCodeInRawReplFallback(code: string): void {
    const sanitized = Stm32H7Bridge._sanitizeForRepl(code);
    const codeBytes = Array.from(new TextEncoder().encode(sanitized));
    const CHUNK_SIZE = 16;
    const CHUNK_DELAY_MS = 80;
    let offset = 0;

    const sendChunk = () => {
      if (offset >= codeBytes.length) {
        this._scheduleReplAction(() => {
          this.sendSerialBytes([0x04]); // Ctrl+D → compile & execute
          this._replState = 'idle';
        }, 200);
        return;
      }
      this.sendSerialBytes(codeBytes.slice(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE;
      this._scheduleReplAction(sendChunk, CHUNK_DELAY_MS);
    };
    sendChunk();
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
