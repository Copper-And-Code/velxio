/**
 * The World panel, over the circuit canvas: the project's world.html running
 * in a sandboxed iframe (Scene), its source (HTML), its files (models,
 * textures) and its log.
 *
 * The iframe has `sandbox="allow-scripts"` and no allow-same-origin, so the
 * page gets an opaque origin: no cookies, no storage of Velxio's, no access
 * to this window. Its only link to the circuit is `window.velxio`
 * (world/worldRuntime.ts), answered here by a WorldHost. The canvas stays
 * mounted underneath, so the boards keep drawing the screens the World shows.
 */
import Editor from '@monaco-editor/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useResolvedTheme } from '../../hooks/useTheme';
import { defineVelxioThemes, monacoThemeFor } from '../editor/monacoThemes';
import {
  fileToB64,
  guessMime,
  MAX_WORLD_ASSET_BYTES,
  useWorldStore,
} from '../../world/useWorldStore';
import { WorldHost, type WorldLogEntry } from '../../world/WorldHost';
import { buildWorldSrcdoc } from '../../world/worldRuntime';
import starterWorld from '../../world/starterWorld.html?raw';
import './WorldPanel.css';

const MAX_LOG = 200;

const errorEntry = (text: string): WorldLogEntry => ({ level: 'error', text, at: Date.now() });

export const WorldPanel = () => {
  const { t } = useTranslation();
  const html = useWorldStore((s) => s.html);
  const assets = useWorldStore((s) => s.assets);
  const tab = useWorldStore((s) => s.tab);
  const revision = useWorldStore((s) => s.revision);
  const { setHtml, setTab, setOpen, reload, putAsset, removeAsset } = useWorldStore.getState();
  const theme = monacoThemeFor(useResolvedTheme());

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<WorldHost | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Log and telemetry belong to one page load (revision).
  const [logState, setLogState] = useState<{ rev: number; entries: WorldLogEntry[] }>({ rev: -1, entries: [] });
  const [telemetryState, setTelemetryState] = useState<{ rev: number; data: Record<string, unknown> } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const log = logState.rev === revision ? logState.entries : [];
  const telemetry = telemetryState?.rev === revision ? telemetryState.data : null;
  const addLog = (rev: number, entry: WorldLogEntry) =>
    setLogState((l) => ({ rev, entries: l.rev === rev ? [...l.entries.slice(-(MAX_LOG - 1)), entry] : [entry] }));
  // The page that runs: the source as of the last Run, so typing in the HTML
  // tab does not restart the scene on every key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const running = useMemo(() => useWorldStore.getState().html, [revision]);
  const srcdoc = useMemo(() => buildWorldSrcdoc(running || starterWorld), [running]);
  const errors = log.filter((l) => l.level === 'error').length;

  // One host per page: the iframe is keyed by the revision, so each Run is a
  // new iframe, and its WindowProxy is the one the page posts from.
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const host = new WorldHost(win);
    host.onLog = (entry) => addLog(revision, entry);
    host.onTelemetry = (data) => setTelemetryState({ rev: revision, data });
    host.setVisible(useWorldStore.getState().tab === 'scene');
    hostRef.current = host;
    return () => {
      host.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [revision]);
  useEffect(() => hostRef.current?.setVisible(tab === 'scene'), [tab]);

  const run = () => {
    reload();
    setTab('scene');
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list)) {
      if (f.size > MAX_WORLD_ASSET_BYTES) {
        addLog(revision, errorEntry(t('editor.world.fileTooBig', { name: f.name })));
        continue;
      }
      putAsset({ name: f.name, mime: f.type || guessMime(f.name), b64: await fileToB64(f) });
    }
  };

  return (
    <div className="world-panel" data-testid="world-panel">
      <div className="world-bar">
        <span className="world-title">{t('editor.world.title')}</span>
        <div className="world-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'scene'}
            className={tab === 'scene' ? 'active' : ''}
            onClick={() => setTab('scene')}
          >
            {t('editor.world.scene')}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'html'}
            className={tab === 'html' ? 'active' : ''}
            onClick={() => setTab('html')}
          >
            HTML
          </button>
        </div>
        <button className="world-btn primary" onClick={run} title={t('editor.world.runTitle')}>
          ▶ {t('editor.world.run')}
        </button>
        {!html.trim() && (
          <button
            className="world-btn"
            onClick={() => {
              setHtml(starterWorld);
              setTab('html');
            }}
            title={t('editor.world.editStarterTitle')}
          >
            {t('editor.world.editStarter')}
          </button>
        )}
        <div className="world-files-wrap">
          <button className="world-btn" onClick={() => setFilesOpen((o) => !o)}>
            {t('editor.world.files')} ({assets.length})
          </button>
          {filesOpen && (
            <div className="world-files">
              {assets.length === 0 && <div className="world-muted">{t('editor.world.noFiles')}</div>}
              {assets.map((a) => (
                <div key={a.name} className="world-file">
                  <code>{a.name}</code>
                  <span className="world-muted">{Math.round((a.b64.length * 0.75) / 1024)} KB</span>
                  <button className="world-x" onClick={() => removeAsset(a.name)} title={t('editor.world.removeFile')}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="world-btn" onClick={() => fileInput.current?.click()}>
                {t('editor.world.addFile')}
              </button>
              <div className="world-muted world-files-hint">{t('editor.world.filesHint')}</div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </div>
        <button
          className={`world-btn${errors ? ' warn' : ''}`}
          onClick={() => setLogOpen((o) => !o)}
          title={t('editor.world.logTitle')}
        >
          {t('editor.world.log')}
          {log.length ? ` (${errors ? `${errors}!` : log.length})` : ''}
        </button>
        <span className="world-spacer" />
        {telemetry && (
          <span className="world-telemetry" title={JSON.stringify(telemetry)}>
            {Object.entries(telemetry)
              .slice(0, 4)
              .map(([k, v]) => `${k}: ${typeof v === 'number' ? +v.toFixed(3) : String(v)}`)
              .join(' · ')}
          </span>
        )}
        <button className="world-x" onClick={() => setOpen(false)} title={t('editor.world.close')}>
          ✕
        </button>
      </div>
      <div className="world-body">
        <iframe
          key={revision}
          ref={iframeRef}
          className="world-frame"
          title="World"
          sandbox="allow-scripts allow-pointer-lock"
          srcDoc={srcdoc}
          style={{ visibility: tab === 'scene' ? 'visible' : 'hidden' }}
        />
        {tab === 'html' && (
          <div className="world-editor">
            {!html.trim() && (
              <div className="world-editor-note">{t('editor.world.starterNote')}</div>
            )}
            <Editor
              height="100%"
              language="html"
              theme={theme}
              beforeMount={defineVelxioThemes}
              value={html || starterWorld}
              onChange={(v) => setHtml(v ?? '')}
              options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', tabSize: 2 }}
            />
          </div>
        )}
        {logOpen && (
          <div className="world-log">
            {log.length === 0 && <div className="world-muted">{t('editor.world.emptyLog')}</div>}
            {log.map((l, i) => (
              <div key={i} className={`world-log-${l.level}`}>
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
