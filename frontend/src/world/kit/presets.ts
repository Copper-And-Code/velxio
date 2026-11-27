import type { Preset } from './types';

/** Physics step (s), the most simulated time one frame may catch up on, the
 *  motors' time constant, and the drive below which a motor does not turn. */
export const STEP = 0.002;
export const BACKLOG = 0.25;
export const LAG = 0.08;
export const DEADBAND = 0.05;

export const PRESETS: Record<string, Preset> = {
  diff2: { L: 0.15, W: 0.105, r: 0.033, track: 0.125, climb: 0.01, grade: 0.3, ahead: 0.065, skid: 1.0, wheels: 2, color: '#2f6fd6' },
  diff4: { L: 0.2, W: 0.115, r: 0.033, track: 0.14, climb: 0.015, grade: 0.36, ahead: 0.09, skid: 1.35, wheels: 4, color: '#d64f2f' },
  tank: { L: 0.225, W: 0.22, r: 0.03, track: 0.19, climb: 0.03, grade: 0.58, ahead: 0.1, skid: 1.6, wheels: 0, color: '#4f7a3a' },
  'maqueen-lite': { L: 0.085, W: 0.081, r: 0.021, track: 0.07, climb: 0.006, grade: 0.25, ahead: 0.035, skid: 1.0, wheels: 2, color: '#1aa0c8' },
};

/** A real panel's width in metres, by board kind: the 4" 480x480 modules, the
 *  7" 1024x600. Anything else with a screen is drawn 6 cm wide. */
export const PANEL_WIDTH: Record<string, number> = {
  'esp32-4848s040': 0.086,
  'waveshare-rp2350-lcd4': 0.086,
  'stm32h7-core-v13': 0.165,
};
