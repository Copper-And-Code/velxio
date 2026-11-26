import { describe, expect, it } from 'vitest';
import { pickRecordingMime, recordingFilename } from '../utils/recording';

describe('recording', () => {
  it('prefers MP4, falls back to WebM, or none', () => {
    expect(pickRecordingMime((m) => m.startsWith('video/mp4'))).toMatch(/^video\/mp4/);
    expect(pickRecordingMime((m) => m === 'video/webm;codecs=vp8,opus')).toBe('video/webm;codecs=vp8,opus');
    expect(pickRecordingMime(() => false)).toBeUndefined();
  });
  it('names the file by time and container', () => {
    const d = new Date(2026, 10, 26, 9, 5, 7);
    expect(recordingFilename('video/mp4;codecs=avc1', d)).toBe('velxio-20261126-090507.mp4');
    expect(recordingFilename('video/webm', d)).toBe('velxio-20261126-090507.webm');
  });
});
