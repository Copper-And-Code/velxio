/**
 * RobotPartElements.ts — the two parts a World kit robot is built from.
 *
 *   velxio-dc-motor     a brushed gear motor (TT style). Pins M+ and M-; the
 *                       simulation (simulation/parts/RobotParts.ts) sets
 *                       `drive` (-1..1, the duty across the winding) and
 *                       `speed` (rpm now), and the hub turns with it. `rpm`
 *                       is the part's property, its no-load speed: the two
 *                       must not share a name, or a property sync (a
 *                       rotation, the dialog) overwrites the live speed.
 *   velxio-line-sensor  an IR reflectance module (TCRT5000 style). Pins VCC,
 *                       GND, DO (HIGH over a dark surface) and AO; the World
 *                       or the sensor panel sets `reflectance` (0 black ..
 *                       100 white).
 *
 * Tags velxio-dc-motor / velxio-line-sensor: metadataIds 'dc-motor' and
 * 'line-sensor' (stripBrandPrefix).
 */

type Pin = { name: string; x: number; y: number; number: number; signals: string[] };

const STYLE = ':host{display:inline-block;line-height:0;position:relative}svg{display:block}';

// ─── DC motor ────────────────────────────────────────────────────────────────

const MOTOR_W = 96;
const MOTOR_H = 64;

class DcMotorElement extends HTMLElement {
  readonly pinInfo: Pin[] = [
    { name: 'M+', x: 4, y: 24, number: 1, signals: [] },
    { name: 'M-', x: 4, y: 40, number: 2, signals: [] },
  ];
  private _drive = 0;
  private _rpm = 200;
  private _speed = 0;
  private angle = 0;
  private raf = 0;
  private last = 0;
  private hub: SVGGElement | null = null;
  private label: SVGTextElement | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML =
      `<style>${STYLE}</style>` +
      `<svg width="${MOTOR_W}" height="${MOTOR_H}" viewBox="0 0 ${MOTOR_W} ${MOTOR_H}" xmlns="http://www.w3.org/2000/svg">` +
      // terminals
      `<rect x="0" y="22" width="12" height="4" fill="#c9a23a"/><rect x="0" y="38" width="12" height="4" fill="#c9a23a"/>` +
      `<text x="14" y="20" font-family="sans-serif" font-size="7" fill="#c33">+</text>` +
      `<text x="14" y="51" font-family="sans-serif" font-size="8" fill="#555">-</text>` +
      // can and gearbox
      `<rect x="10" y="16" width="34" height="32" rx="6" fill="#b8c0c6" stroke="#6b757c"/>` +
      `<rect x="42" y="10" width="34" height="44" rx="3" fill="#f2c230" stroke="#a8851d"/>` +
      // output hub
      `<g transform="translate(76 32)"><circle r="15" fill="#2b3135" stroke="#15191c" stroke-width="1.5"/>` +
      `<g id="hub"><rect x="-1.6" y="-13" width="3.2" height="26" fill="#d8dde1"/><rect x="-13" y="-1.6" width="26" height="3.2" fill="#d8dde1"/></g>` +
      `<circle r="3" fill="#f2c230"/></g>` +
      `<text id="lbl" x="59" y="61" text-anchor="middle" font-family="sans-serif" font-size="7" fill="#777"></text>` +
      `</svg>`;
    this.hub = this.shadowRoot!.getElementById('hub') as unknown as SVGGElement;
    this.label = this.shadowRoot!.getElementById('lbl') as unknown as SVGTextElement;
  }

  get drive(): number { return this._drive; }
  set drive(v: number) {
    this._drive = Math.max(-1, Math.min(1, Number(v) || 0));
    if (this.label) this.label.textContent = this._drive ? `${Math.round(this._drive * 100)}%` : '';
    if (this._drive && !this.raf && this.isConnected) this.spin();
  }
  /** The no-load speed (the `rpm` property). */
  get rpm(): number { return this._rpm; }
  set rpm(v: number) { this._rpm = Number(v) > 0 ? Number(v) : 200; }
  /** The speed now, in rpm, signed. */
  get speed(): number { return this._speed; }
  set speed(v: number) { this._speed = Number(v) || 0; }

  disconnectedCallback() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private spin() {
    this.last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      // shown at a fifth of the real speed, so the turning reads as turning
      this.angle = (this.angle + (this._speed / 60) * 360 * dt * 0.2) % 360;
      this.hub?.setAttribute('transform', `rotate(${this.angle.toFixed(1)})`);
      this.raf = this._drive ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }
}

// ─── IR line sensor ──────────────────────────────────────────────────────────

const LINE_W = 56;
const LINE_H = 80;

class LineSensorElement extends HTMLElement {
  readonly pinInfo: Pin[] = ['VCC', 'GND', 'DO', 'AO'].map((name, i) => ({
    name,
    x: 10 + i * 12,
    y: 2,
    number: i + 1,
    signals: [],
  }));
  private _reflectance = 100;
  private _out = false;
  private led: SVGCircleElement | null = null;

  constructor() {
    super();
    const pins = this.pinInfo
      .map((p) => `<rect x="${p.x - 2}" y="0" width="4" height="9" fill="#c9a23a"/>` +
        `<text x="${p.x}" y="17" text-anchor="middle" font-family="sans-serif" font-size="5" fill="#cfe">${p.name}</text>`)
      .join('');
    this.attachShadow({ mode: 'open' }).innerHTML =
      `<style>${STYLE}</style>` +
      `<svg width="${LINE_W}" height="${LINE_H}" viewBox="0 0 ${LINE_W} ${LINE_H}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="2" y="8" width="52" height="70" rx="3" fill="#1d4f91" stroke="#123366"/>` + pins +
      `<rect x="22" y="24" width="12" height="10" rx="1" fill="#e9e9e9"/>` +
      `<circle id="led" cx="10" cy="29" r="2.6" fill="#3a1010"/>` +
      `<text x="10" y="38" text-anchor="middle" font-family="sans-serif" font-size="4" fill="#cfe">D0</text>` +
      `<rect x="14" y="58" width="28" height="16" rx="2" fill="#111" stroke="#333"/>` +
      `<circle cx="22" cy="66" r="5" fill="#2a2a55"/><circle cx="34" cy="66" r="5" fill="#222"/>` +
      `<text x="28" y="52" text-anchor="middle" font-family="sans-serif" font-size="5" fill="#cfe">LINE</text>` +
      `</svg>`;
    this.led = this.shadowRoot!.getElementById('led') as unknown as SVGCircleElement;
  }

  get reflectance(): number { return this._reflectance; }
  set reflectance(v: number) { this._reflectance = Math.max(0, Math.min(100, Number(v) || 0)); }
  /** The DO level the simulation drives, shown on the module's LED. */
  get out(): boolean { return this._out; }
  set out(v: boolean) {
    this._out = !!v;
    this.led?.setAttribute('fill', this._out ? '#ff3b30' : '#3a1010');
  }
}

if (!customElements.get('velxio-dc-motor')) customElements.define('velxio-dc-motor', DcMotorElement);
if (!customElements.get('velxio-line-sensor')) customElements.define('velxio-line-sensor', LineSensorElement);

export {};
