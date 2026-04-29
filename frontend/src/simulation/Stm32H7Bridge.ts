/**
 * Stm32H7Bridge
 *
 * WebSocket connection from frontend to backend RenodeManager
 * for one STM32H7_CORE V13 board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'start_stm32', data: { board: 'stm32-h7-core-v13', firmware_path?: string } }
 *     { type: 'stop_stm32' }
 *     { type: 'stm32_serial_input', data: { bytes: number[] } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output', data: { data: string } }
 *     { type: 'system',        data: { event: string } }
 *     { type: 'error',         data: { message: string } }
 *     { type: 'framebuffer',   data: { width, height, pitch, format, bytes_b64 } }
 *
 * GPIO/touch channels are not yet wired (see roadmap phase 4).
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

  private socket: WebSocket | null = null;
  private _connected = false;
  private firmwarePath: string | null = null;

  constructor(boardId: string, firmwarePath: string | null = null) {
    this.boardId = boardId;
    this.firmwarePath = firmwarePath;
  }

  get connected(): boolean {
    return this._connected;
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
          break;
        }
        case 'system':
          this.onSystemEvent?.(msg.data.event as string, msg.data);
          break;
        case 'error':
          this.onError?.(msg.data.message as string);
          break;
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

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
