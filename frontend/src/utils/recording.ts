/** Helpers of the simulation recorder (components/simulator/RecordButton). */

/** The element the recording is cropped to. */
export const RECORD_AREA_SELECTOR = '.simulator-panel';

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickRecordingMime(
  isSupported: (m: string) => boolean = (m) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
): string | undefined {
  return MIME_CANDIDATES.find((m) => isSupported(m));
}

export function recordingFilename(mime: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `velxio-${stamp}.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
}
