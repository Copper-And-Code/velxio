/**
 * Record the simulation to a video file.
 *
 * The browser captures this tab (getDisplayMedia, asking the user once per
 * recording) and, where Region Capture exists (Chromium), crops it to the
 * simulator panel: the canvas or the World over it, and the serial monitor
 * when it is open. MediaRecorder writes MP4 where the browser can, WebM
 * otherwise; Stop (or ending the share from the browser bar) downloads it.
 * The tab's audio comes along when the user leaves "share audio" on.
 *
 * Capturing pixels, not canvases, is what lets one recording hold the board
 * screens, the wokwi parts and the World's sandboxed iframe alike.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pickRecordingMime, RECORD_AREA_SELECTOR, recordingFilename } from '../../utils/recording';

interface CropCapableTrack extends MediaStreamTrack {
  cropTo?: (target: unknown) => Promise<void>;
}

declare global {
  // Region Capture (Chromium): not in the DOM lib yet.
  var CropTarget: { fromElement(el: Element): Promise<unknown> } | undefined;
}

export const RecordButton = () => {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);

  const cleanup = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
    recorder.current = null;
    setRecording(false);
  };

  useEffect(
    () => () => {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      else cleanup();
    },
    [],
  );

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else cleanup();
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      window.alert(t('editor.record.unsupported'));
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
        // Chromium hints: offer this tab first, keep the user on it.
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      } as DisplayMediaStreamOptions);
    } catch {
      return; // the user cancelled the share dialog
    }
    stream.current = media;
    const [video] = media.getVideoTracks() as CropCapableTrack[];
    // Crop to the simulator; only works when the shared surface is this tab.
    const area = document.querySelector(RECORD_AREA_SELECTOR);
    if (area && video?.cropTo && globalThis.CropTarget) {
      try {
        await video.cropTo(await globalThis.CropTarget.fromElement(area));
      } catch {
        /* another tab or window was shared: record it whole */
      }
    }
    const mime = pickRecordingMime();
    const rec = new MediaRecorder(media, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 6_000_000,
    });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || mime || 'video/webm';
      const blob = new Blob(chunks, { type });
      cleanup();
      if (!blob.size) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = recordingFilename(type);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    };
    // The user may end the share from the browser's own bar.
    video?.addEventListener('ended', () => {
      if (rec.state === 'recording') rec.stop();
    });
    recorder.current = rec;
    rec.start(1000);
    const t0 = Date.now();
    setElapsed(0);
    timer.current = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    setRecording(true);
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <button
      onClick={() => (recording ? stop() : void start())}
      className={`canvas-serial-btn${recording ? ' canvas-serial-btn-active' : ''}`}
      title={recording ? t('editor.record.stopTitle') : t('editor.record.startTitle')}
      data-testid="record-toggle"
      style={recording ? { color: '#ff5252' } : undefined}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        {recording ? (
          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
        ) : (
          <circle cx="12" cy="12" r="6" fill="#e53935" stroke="none" />
        )}
      </svg>
      {recording ? `${mm}:${ss}` : t('editor.record.label')}
    </button>
  );
};
