/**
 * What this fork changes about a build with no pro overlay (VITE_PRO_BUILD
 * unset): the open-source build of Copper-And-Code/velxio.
 *
 * Upstream's open-source tree lists every example and board, and the boards
 * whose emulators live only in the paid overlay (STM32 F1/F4 on QEMU, the
 * Raspberry Pi Linux boards: isProBoardKind) answer "paid plan" at Run. Here
 * nothing that cannot start is offered: the gallery and the starter dialog
 * leave those boards out. With the overlay present nothing changes.
 *
 * It uses the seams upstream keeps for the overlay (galleryExampleFilter), so
 * an overlay build still installs its own filter over this one.
 */
import type { ExampleProject } from '../data/examples';
import { installGalleryExampleFilter } from '../lib/galleryExampleFilter';
import { isProBoardKind } from '../lib/proBoardGate';
import { isKnownBoardKind } from '../types/board';

/** Where this build's source is (AGPLv3 section 13: the users of a hosted
 *  instance get the source of the version they use). */
export const SOURCE_REPO_URL = 'https://github.com/Copper-And-Code/velxio';
/** The project this is a fork of, credited on the credits page. */
export const UPSTREAM_REPO_URL = 'https://github.com/davidmonterocrespo24/velxio';

export const HAS_PRO_OVERLAY = Boolean(import.meta.env.VITE_PRO_BUILD);

/** Whether a board of `kind` can start in this build. */
export function boardRunsHere(kind: string): boolean {
  if (HAS_PRO_OVERLAY) return true;
  return isKnownBoardKind(kind) && !isProBoardKind(kind);
}

/** The board kinds an example puts on the canvas. */
function exampleBoardKinds(ex: ExampleProject): string[] {
  const kinds = (ex.boards ?? []).map((b) => b.boardKind as string);
  if (ex.boardType) kinds.push(ex.boardType);
  return kinds;
}

/** Whether every board of an example can start in this build (board-less
 *  circuit examples always can). */
export function exampleRunsHere(ex: ExampleProject): boolean {
  return exampleBoardKinds(ex).every(boardRunsHere);
}

/** Install the gallery filter of the open build. Call once at startup. */
export function installOpenBuildFilters(): void {
  if (HAS_PRO_OVERLAY) return;
  installGalleryExampleFilter((examples) => examples.filter(exampleRunsHere));
}
