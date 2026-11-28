/**
 * The clock of a board that runs in another process, as this page can know it.
 *
 * A board in the page has a clock the page reads (an AVR's cycle counter):
 * a World scene steps its physics on it, a sensor its waveform, and both keep
 * step with the firmware whatever speed it is emulated at. A board in a QEMU
 * or Renode process keeps its clock there. When that clock is the host's
 * (QEMU without -icount) the page's own clock is the same thing and nothing
 * is needed. When it counts instructions (QEMU under -icount, Renode) it runs
 * slower than the wall clock whenever the host cannot keep up, and stops
 * when the emulator does: a scene stepped on the wall clock then moves its
 * robot two or three times as far between two looks of the firmware as the
 * firmware thinks, and on while the emulator stands still.
 *
 * Such a board says what its clock reads, a few tens of times a second
 * (`guest_clock`). Between two of those the clock goes on at the rate the
 * last ones showed, so what is stepped on it moves smoothly and not in jumps
 * of a beacon. It goes on for COAST_MS at most: a board that stopped talking
 * has stopped, as far as this page knows.
 */

/** Beacons kept to tell the rate: this much of them, in page milliseconds. */
const RATE_WINDOW_MS = 300;
/** How far past the last beacon the clock goes on, in page milliseconds. */
const COAST_MS = 80;
/** A guest never runs this many times faster than the wall clock: a rate
 *  above it is two beacons the network delivered together. */
const MAX_RATE = 4;
/** A clock this far behind the last beacon has started again (a reset). */
const RESTART_US = 50_000;

export class RemoteGuestClock {
  /** [guest microseconds, page milliseconds it was heard at], oldest first. */
  private beacons: Array<[number, number]> = [];
  /** Guest microseconds per page millisecond. */
  private rate = 1000;
  /** What read() last answered: the clock never goes back. */
  private shown = -1;

  /** Forget the board: a new run starts with no clock until it says one. */
  reset(): void {
    this.beacons = [];
    this.rate = 1000;
    this.shown = -1;
  }

  /** The board's clock reads `us` microseconds, heard at `now`. */
  update(us: number, now: number = performance.now()): void {
    if (!Number.isFinite(us) || us < 0) return;
    const last = this.beacons[this.beacons.length - 1];
    if (last && us < last[0] - RESTART_US) this.reset();
    else if (last && us < last[0]) return; // an old beacon, out of order
    this.beacons.push([us, now]);
    while (this.beacons.length > 2 && now - this.beacons[1][1] >= RATE_WINDOW_MS) {
      this.beacons.shift();
    }
    const first = this.beacons[0];
    const span = now - first[1];
    // One beacon tells no rate, and two heard in the same instant neither.
    if (this.beacons.length > 1 && span >= 1) {
      this.rate = Math.min((us - first[0]) / span, MAX_RATE * 1000);
    }
  }

  /** The board's clock at `now`, in microseconds; -1 while it has said none. */
  read(now: number = performance.now()): number {
    const last = this.beacons[this.beacons.length - 1];
    if (!last) return -1;
    const since = Math.min(Math.max(now - last[1], 0), COAST_MS);
    const us = last[0] + since * this.rate;
    if (us > this.shown) this.shown = us;
    return this.shown;
  }
}
