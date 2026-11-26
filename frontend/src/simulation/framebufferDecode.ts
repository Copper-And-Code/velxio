/**
 * Pixels of an emulated panel's framebuffer (as the backend bridges send them:
 * little-endian rows of `pitch` bytes) to the RGBA a canvas takes. Shared by the
 * STM32H743 Core display and the ESP32-S3 panel boards.
 */
export type PanelPixelFormat = 'rgb565' | 'rgb888' | 'argb8888' | 'xrgb8888';

export function decodeFramebufferToRGBA(
  src: Uint8Array,
  width: number,
  height: number,
  pitch: number,
  format: PanelPixelFormat | string,
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
    case 'xrgb8888':
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
          out[o + 3] = format === 'xrgb8888' ? 0xff : (src[s + 3] ?? 0xff);
        }
      }
      return out;
    }
    default:
      return null;
  }
}
