import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state';
import { useSaveSync } from '../sync/SaveSyncProvider';

const SAVE_PATH = String.raw`%LOCALAPPDATA%\FactoryGame\Saved\SaveGames`;
const HELPER_FOLDER = 'N.O.D.E.S Saves';

export function ago(ms: number | null, now = Date.now()) {
  if (!ms) return 'unknown';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Re-render every 30 s so "x min ago" stays current. */
function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function SaveSyncCard() {
  const { state, dispatch } = useStore();
  const sync = useSaveSync();
  const fileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const now = useClock();
  const g = state.game;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(SAVE_PATH);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="card sync-card">
      <div className="row between wrap">
        <h2>Sync from your game</h2>
        {sync.folder === 'watching' && (
          <span className={`sync-dot ${state.sync.auto ? 'live' : ''}`}>{state.sync.auto ? 'Watching for new saves' : 'Auto-sync paused'}</span>
        )}
      </div>

      {sync.folder === 'unsupported' && (
        <p className="muted small-text">This browser can’t remember folders (Chrome or Edge can). Drag a <b>.sav</b> file onto this page, or pick one below, whenever you want to sync.</p>
      )}

      {sync.folder === 'none' && (
        <>
          <p className="muted small-text">Connect a save folder once. N.O.D.E.S then reads your newest save every time the game saves, and fills in tier, milestones, MAM research, alternates, power shards and somersloops. Nothing is uploaded — the save is read in this browser.</p>
          <ol className="sync-steps small-text">
            <li>
              <b>Install the save helper (once).</b> Chrome won’t open the game’s own save folder (it’s inside AppData), so this small script copies new saves to <code>Documents\{HELPER_FOLDER}</code>.{' '}
              <a href="/nodes-save-helper.ps1" download>Download nodes-save-helper.ps1</a>, then right-click it → <b>Run with PowerShell</b>. It starts with Windows and runs in the background.
            </li>
            <li>
              <button className="primary" onClick={sync.connect}>Connect save folder</button>{' '}
              In the picker, click <b>Documents</b>, select <b>{HELPER_FOLDER}</b>, then press <b>Select folder</b>.
            </li>
          </ol>
          <p className="muted small-text">Without the helper: drag a save from <code>{SAVE_PATH}</code> onto this page whenever you want to sync. <button className="small ghost" onClick={copyPath}>{copied ? 'Copied' : 'Copy that path'}</button></p>
        </>
      )}

      {sync.folder === 'needs-permission' && (
        <div className="row gap wrap">
          <button className="primary" onClick={sync.reconnect}>Sync “{sync.folderName}”</button>
          <span className="muted small-text">Your browser needs a click to let N.O.D.E.S read the save folder again. Pick <b>Allow on every visit</b> to skip this next time.</span>
        </div>
      )}

      {sync.folder === 'watching' && (
        <div className="row gap wrap">
          <label className="row gap">
            Session
            <select value={state.sync.session ?? ''} onChange={(e) => dispatch({ type: 'syncPrefs', patch: { session: e.target.value } })}>
              {sync.sessions.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={state.sync.auto} onChange={(e) => dispatch({ type: 'syncPrefs', patch: { auto: e.target.checked } })} />
            Auto-sync
          </label>
          <button className="small" onClick={sync.syncNow} disabled={!!sync.busy}>Sync now</button>
          <button className="small ghost" onClick={sync.disconnect}>Disconnect folder</button>
        </div>
      )}

      {sync.busy && (
        <div className="sync-progress">
          <div className="muted small-text">Reading {sync.busy.file}…</div>
          <div className="bar"><div style={{ width: `${Math.round(sync.busy.progress * 100)}%` }} /></div>
        </div>
      )}

      {g && !sync.busy && (
        <div className="sync-summary small-text">
          <div>Last sync: <b>{g.saveName}</b> (saved {ago(g.savedAt ?? g.fileModified, now)}, synced {ago(g.syncedAt, now)})</div>
          <div className="muted">
            Power shards: {g.shards.total} owned ({g.shards.slotted} slotted in machines) · Somersloops: {g.sloops.total} owned ({g.sloops.slotted} slotted) ·
            {' '}{g.occupied.length} nodes already mined in game, shown on the map
          </div>
        </div>
      )}

      {sync.message && !sync.busy && <div className={`small-text ${sync.message.tone === 'error' ? 'warn' : 'ok-text'}`}>{sync.message.text}</div>}

      <div className="row gap wrap sync-file">
        <button className="small ghost" onClick={() => fileRef.current?.click()}>Import one save file…</button>
        <span className="muted small-text">or drag a .sav file anywhere onto the page.</span>
        {g && <button className="small ghost" onClick={() => dispatch({ type: 'forgetGame' })}>Clear synced map data</button>}
        <input ref={fileRef} type="file" accept=".sav" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) sync.importFile(f); e.target.value = ''; }} />
      </div>
      {g && <p className="muted small-text">Syncing replaces the tier, milestone, research and alternate ticks below with what’s in your save. Change them by hand any time — the next new save will overwrite them again{state.sync.auto && sync.folder === 'watching' ? ' (turn off Auto-sync to keep your edits)' : ''}.</p>}
    </section>
  );
}
