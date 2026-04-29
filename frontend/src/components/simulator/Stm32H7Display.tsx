import React, { useEffect, useRef, useState } from 'react';
import type { Stm32Framebuffer, Stm32PixelFormat } from '../../simulation/Stm32H7Bridge';
import { getStm32Bridge } from '../../store/useSimulatorStore';

const DEFAULT_W = 1024;
const DEFAULT_H = 600;
const DEFAULT_SCALE = 0.4;

interface Stm32H7DisplayProps {
  id: string;
  x: number;
  y: number;
  scale?: number;
}

export const Stm32H7Display = ({
  id,
  x,
  y,
  scale = DEFAULT_SCALE,
}: Stm32H7DisplayProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [framebuffer, setFramebuffer] = useState<Stm32Framebuffer | null>(null);

  // Subscribe to framebuffer events from the active Stm32H7Bridge.
  useEffect(() => {
    const bridge = getStm32Bridge(id);
    if (!bridge) return;
    const prev = bridge.onFramebuffer;
    bridge.onFramebuffer = (fb) => {
      setFramebuffer(fb);
      prev?.(fb);
    };
    return () => {
      if (bridge.onFramebuffer && bridge.onFramebuffer !== prev) {
        bridge.onFramebuffer = prev;
      }
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

  const w = framebuffer?.width ?? DEFAULT_W;
  const h = framebuffer?.height ?? DEFAULT_H;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w * scale,
        height: h * scale,
        background: '#000',
        border: '2px solid #444',
        borderRadius: 4,
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <canvas
        ref={canvasRef}
        width={w}
        height={h}
        style={{
          width:  '100%',
          height: '100%',
          imageRendering: 'pixelated',
          display: 'block',
        }}
      />
    </div>
  );
};

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
