/**
 * velxio.kit, as the script the World's runtime carries.
 *
 * The kit itself is the TypeScript in ./kit/ (start at kit/index.ts). It runs
 * inside the World's page, which gets its scripts as text, so the build
 * bundles it into one script (`virtual:world-kit`, vite-plugin-world-kit.ts)
 * that leaves `VelxioKit.makeKit`. The runtime script (worldRuntime.ts) puts
 * this text in front of `velxio.kit = makeKit(velxio, send)`.
 */
import KIT_BUNDLE from 'virtual:world-kit';

/** The kit's script, with the three.js module it loads for the 3D view. */
export function worldKitJs(threeUrl: string): string {
  return KIT_BUNDLE.replace('__THREE_URL__', () => threeUrl) + '\nvar makeKit = VelxioKit.makeKit;\n';
}
