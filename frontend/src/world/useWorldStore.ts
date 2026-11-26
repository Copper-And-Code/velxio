/**
 * The project's World: `world.html`, a page that puts the circuit in a scene
 * (3D with three.js, or 2D), plus the files it loads (models, textures).
 *
 * The page runs in a sandboxed iframe (WorldPanel) and reaches the
 * simulation only through `window.velxio` (worldRuntime.ts, WorldHost.ts).
 * It belongs to the project, not to a board's file group: a MicroPython
 * board would otherwise upload it to the chip, and a compiler would see it.
 * It travels in the .vlx file and in examples (`world` field).
 */
import { create } from 'zustand';

export interface WorldAsset {
  /** File name the page asks for: `await velxio.asset('robot.glb')`. */
  name: string;
  mime: string;
  /** Contents, base64 (the .vlx file is JSON). */
  b64: string;
}

export interface WorldData {
  html: string;
  assets?: WorldAsset[];
}

export type WorldTab = 'scene' | 'html';

interface WorldState {
  html: string;
  assets: WorldAsset[];
  /** The World panel is shown over the canvas. */
  open: boolean;
  tab: WorldTab;
  /** Bumped to reload the page (Run in the panel, a new project). */
  revision: number;
  setHtml: (html: string) => void;
  putAsset: (asset: WorldAsset) => void;
  removeAsset: (name: string) => void;
  setOpen: (open: boolean) => void;
  setTab: (tab: WorldTab) => void;
  reload: () => void;
  /** Replace the World with a project's (none: an empty World). */
  load: (world?: WorldData | null) => void;
  /** What the project saves: undefined while the World is empty. */
  snapshot: () => WorldData | undefined;
}

export const MAX_WORLD_ASSET_BYTES = 24 * 1024 * 1024;

export const useWorldStore = create<WorldState>((set, get) => ({
  html: '',
  assets: [],
  open: false,
  tab: 'scene',
  revision: 0,
  setHtml: (html) => set({ html }),
  putAsset: (asset) =>
    set((s) => ({ assets: [...s.assets.filter((a) => a.name !== asset.name), asset] })),
  removeAsset: (name) => set((s) => ({ assets: s.assets.filter((a) => a.name !== name) })),
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
  reload: () => set((s) => ({ revision: s.revision + 1 })),
  load: (world) =>
    set((s) => ({
      html: typeof world?.html === 'string' ? world.html : '',
      assets: Array.isArray(world?.assets)
        ? world!.assets.filter(
            (a) => a && typeof a.name === 'string' && typeof a.b64 === 'string',
          ).map((a) => ({ name: a.name, mime: a.mime || 'application/octet-stream', b64: a.b64 }))
        : [],
      revision: s.revision + 1,
    })),
  snapshot: () => {
    const { html, assets } = get();
    if (!html.trim() && assets.length === 0) return undefined;
    return assets.length ? { html, assets } : { html };
  },
}));

/** Base64 of a file the user picked, for a WorldAsset. */
export async function fileToB64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A MIME type for a file name, for the Blob URL the page loads. */
export function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      glb: 'model/gltf-binary',
      gltf: 'model/gltf+json',
      bin: 'application/octet-stream',
      obj: 'text/plain',
      stl: 'model/stl',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      hdr: 'image/vnd.radiance',
      ktx2: 'image/ktx2',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      json: 'application/json',
      js: 'text/javascript',
    } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}
