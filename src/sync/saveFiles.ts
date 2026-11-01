import type { SaveSummary } from '../engine/saveReader';
import { sessionFromFile } from '../engine/saveReader';
import { idbGet, idbSet } from '../components/idb';

// ---------- Parsing in a worker ----------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (s: SaveSummary) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./saveWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; progress?: number; summary?: SaveSummary; error?: string }>) => {
    const job = pending.get(e.data.id);
    if (!job) return;
    if (e.data.progress !== undefined) return job.onProgress?.(e.data.progress);
    pending.delete(e.data.id);
    if (e.data.summary) job.resolve(e.data.summary);
    else job.reject(new Error(e.data.error ?? 'Could not read the save'));
  };
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || 'Save reader crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export async function parseSaveFile(file: File, onProgress?: (p: number) => void): Promise<SaveSummary> {
  const bytes = await file.arrayBuffer();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, bytes, name: file.name }, [bytes]);
  });
}

// ---------- Remembered save folder (Chrome / Edge) ----------

// The File System Access API isn't in TypeScript's DOM types yet, so type the bits we use.
type Perm = 'granted' | 'denied' | 'prompt';
export interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  queryPermission(o: { mode: 'read' }): Promise<Perm>;
  requestPermission(o: { mode: 'read' }): Promise<Perm>;
}
export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const FOLDER_KEY = 'save-folder';

export async function pickFolder(): Promise<DirHandle> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const h = await pick({ id: 'nodes-saves', mode: 'read' });
  await idbSet(FOLDER_KEY, h);
  return h;
}
export const storedFolder = () => idbGet<DirHandle>(FOLDER_KEY);
export const forgetFolder = () => idbSet(FOLDER_KEY, undefined);

export async function hasAccess(h: DirHandle, ask: boolean) {
  const opts = { mode: 'read' as const };
  if ((await h.queryPermission(opts)) === 'granted') return true;
  if (!ask) return false;
  return (await h.requestPermission(opts)) === 'granted';
}

export interface SaveEntry {
  name: string;
  session: string;
  lastModified: number;
  size: number;
  handle: FileHandle;
}

/**
 * All .sav files in the folder. If the person picked the parent SaveGames folder,
 * also look one level down (the game keeps saves in a folder named after the account id).
 */
export async function listSaves(dir: DirHandle): Promise<SaveEntry[]> {
  const out: SaveEntry[] = [];
  const scan = async (d: DirHandle, depth: number) => {
    for await (const e of d.values()) {
      if (e.kind === 'directory') {
        if (depth === 0 && e.name.toLowerCase() !== 'blueprints') await scan(e, 1);
        continue;
      }
      if (!/\.sav$/i.test(e.name) || /^ServerManager/i.test(e.name)) continue;
      const f = await e.getFile();
      if (f.size < 1024) continue; // tiny .sav files are settings, not worlds
      out.push({ name: e.name, session: sessionFromFile(e.name), lastModified: f.lastModified, size: f.size, handle: e });
    }
  };
  await scan(dir, 0);
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

/** Session names, newest first. */
export function sessionsOf(saves: SaveEntry[]) {
  const seen = new Map<string, number>();
  for (const s of saves) if (!seen.has(s.session)) seen.set(s.session, s.lastModified);
  return [...seen.entries()].map(([name, lastModified]) => ({ name, lastModified }));
}
