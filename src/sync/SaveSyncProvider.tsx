import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SaveSummary } from '../engine/saveReader';
import { describeChange, gameSyncFromSave, progressFromSave, type GameSync } from '../engine/saveSync';
import { useStore } from '../state';
import {
  folderSupported, forgetFolder, hasAccess, listSaves, parseSaveFile, pickFolder, sessionsOf, storedFolder, type DirHandle,
} from './saveFiles';

export type FolderStatus = 'unsupported' | 'none' | 'needs-permission' | 'watching';

interface SyncCtx {
  folder: FolderStatus;
  folderName: string | null;
  sessions: { name: string; lastModified: number }[];
  /** Name of the save being read and how far along (0–1), or null. */
  busy: { file: string; progress: number } | null;
  message: { text: string; tone: 'ok' | 'error' } | null;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
  syncNow(): Promise<void>;
  importFile(file: File): Promise<void>;
}

const Ctx = createContext<SyncCtx | null>(null);
const POLL_MS = 5000;

export function SaveSyncProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const [folder, setFolder] = useState<FolderStatus>(folderSupported ? 'none' : 'unsupported');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SyncCtx['sessions']>([]);
  const [busy, setBusy] = useState<SyncCtx['busy']>(null);
  const [message, setMessage] = useState<SyncCtx['message']>(null);
  const [dragging, setDragging] = useState(false);

  const handle = useRef<DirHandle | null>(null);
  const working = useRef(false);
  // Latest store values for the polling loop, without restarting it on every change.
  const live = useRef(state);
  live.current = state;

  const apply = useCallback((s: SaveSummary, modified: number | null, source: GameSync['source']) => {
    const before = live.current.progress;
    const progress = progressFromSave(s);
    dispatch({ type: 'gameSync', progress, game: gameSyncFromSave(s, modified, source) });
    setMessage({ text: `Synced “${s.saveName}” — ${describeChange(before, progress)}.`, tone: 'ok' });
  }, [dispatch]);

  const read = useCallback(async (file: File, source: GameSync['source']) => {
    setBusy({ file: file.name, progress: 0 });
    try {
      const s = await parseSaveFile(file, (p) => setBusy({ file: file.name, progress: p }));
      apply(s, file.lastModified, source);
    } catch (e) {
      setMessage({ text: `Couldn’t read ${file.name}: ${e instanceof Error ? e.message : e}. A game update may have changed the save format.`, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }, [apply]);

  /** Look in the folder; read the newest save of the chosen session if it's newer than the last sync. */
  const poll = useCallback(async (force: boolean) => {
    const dir = handle.current;
    if (!dir || working.current) return;
    working.current = true;
    try {
      if (!(await hasAccess(dir, false))) {
        setFolder('needs-permission');
        return;
      }
      const saves = await listSaves(dir);
      const list = sessionsOf(saves);
      setSessions(list);
      if (!list.length) {
        setMessage({ text: `No Satisfactory saves found in “${dir.name}”. Pick the SaveGames folder or the numbered folder inside it.`, tone: 'error' });
        return;
      }
      const { sync, game } = live.current;
      let session = sync.session;
      if (!session || !list.some((x) => x.name === session)) {
        session = list[0].name;
        dispatch({ type: 'syncPrefs', patch: { session } });
      }
      const newest = saves.find((s) => s.session === session)!;
      // A different newest file (new autosave, or another session picked) means there is something to sync.
      const stale = !game || game.fileModified !== newest.lastModified;
      if (force || (sync.auto && stale)) await read(await newest.handle.getFile(), 'folder');
    } catch (e) {
      setMessage({ text: `Couldn’t check the save folder: ${e instanceof Error ? e.message : e}`, tone: 'error' });
    } finally {
      working.current = false;
    }
  }, [dispatch, read]);

  // Restore the remembered folder on start.
  useEffect(() => {
    if (!folderSupported) return;
    let cancelled = false;
    (async () => {
      const dir = await storedFolder();
      if (!dir || cancelled) return;
      handle.current = dir;
      setFolderName(dir.name);
      const ok = await hasAccess(dir, false).catch(() => false);
      if (cancelled) return;
      setFolder(ok ? 'watching' : 'needs-permission');
      if (ok) poll(false);
    })();
    return () => { cancelled = true; };
  }, [poll]);

  // Check every few seconds while watching, and straight away when the tab comes back into focus.
  useEffect(() => {
    if (folder !== 'watching') return;
    const tick = () => { if (live.current.sync.auto) poll(false); };
    const id = window.setInterval(tick, POLL_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [folder, poll]);

  // Switching session or turning auto-sync back on syncs right away.
  useEffect(() => {
    if (folder === 'watching') poll(false);
  }, [state.sync.session, state.sync.auto]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop a .sav anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.sav$/i.test(f.name));
      if (file) read(file, 'file');
      else setMessage({ text: 'That isn’t a Satisfactory save (.sav) file.', tone: 'error' });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [read]);

  const value = useMemo<SyncCtx>(() => ({
    folder, folderName, sessions, busy, message,
    async connect() {
      try {
        const dir = await pickFolder();
        handle.current = dir;
        setFolderName(dir.name);
        setFolder('watching');
        await poll(true);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // picker closed
        setMessage({ text: `Couldn’t open that folder: ${e instanceof Error ? e.message : e}`, tone: 'error' });
      }
    },
    async reconnect() {
      const dir = handle.current;
      if (!dir) return;
      if (await hasAccess(dir, true).catch(() => false)) {
        setFolder('watching');
        await poll(false);
      } else setMessage({ text: 'Folder access wasn’t allowed.', tone: 'error' });
    },
    async disconnect() {
      await forgetFolder();
      handle.current = null;
      setFolderName(null);
      setSessions([]);
      setFolder(folderSupported ? 'none' : 'unsupported');
      setMessage(null);
    },
    syncNow: () => poll(true),
    importFile: (file: File) => read(file, 'file'),
  }), [folder, folderName, sessions, busy, message, poll, read]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {dragging && <div className="drop-overlay"><div>Drop your <b>.sav</b> file to sync progress</div></div>}
    </Ctx.Provider>
  );
}

export function useSaveSync() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSaveSync outside provider');
  return c;
}
