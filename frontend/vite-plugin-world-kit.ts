/**
 * `virtual:world-kit`: the World kit (src/world/kit/) as one script, a string.
 *
 * The kit runs inside the World's page, a sandboxed iframe that gets its
 * scripts as text in its srcdoc, so it cannot be imported there. It used to be
 * written as a 1200-line string literal for that reason, out of reach of the
 * type checker, the linter and the unit tests. It is ordinary TypeScript
 * modules now, and this plugin bundles them (esbuild, an IIFE that leaves
 * `VelxioKit.makeKit`) whenever something imports the virtual module:
 * src/world/worldKit.ts does, for the World's runtime script.
 *
 * Shared by vite.config.ts and vitest.config.ts (vitest does not read the
 * former's plugins).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import type { Plugin } from 'vite';

const VIRTUAL = 'virtual:world-kit';
const RESOLVED = '\0' + VIRTUAL;
const here = path.dirname(fileURLToPath(import.meta.url));

export function worldKitPlugin(): Plugin {
  const entry = path.resolve(here, 'src/world/kit/index.ts');
  return {
    name: 'velxio-world-kit',
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    async load(id) {
      if (id !== RESOLVED) return undefined;
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'VelxioKit',
        // The kit loads three.js with import(): new enough to keep it as it is.
        target: 'es2020',
        legalComments: 'none',
        metafile: true,
        logLevel: 'silent',
      });
      // A change to any of the kit's files makes the bundle anew.
      for (const input of Object.keys(result.metafile.inputs)) {
        this.addWatchFile(path.resolve(here, input));
      }
      return 'export default ' + JSON.stringify(result.outputFiles[0].text) + ';';
    },
  };
}
