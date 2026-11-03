// A world is stored as separate rows ("docs") so players editing different factories don't overwrite each other:
// 'progress', 'game', 'foundNames', 'groupRules', and one 'factory:<id>' per factory (data null = deleted).
import type { Factory } from '../engine/types';
import type { State } from '../state';

export interface DocRow { key: string; data: unknown }

const SHARED = ['progress', 'game', 'foundNames', 'groupRules'] as const;
type SharedKey = (typeof SHARED)[number];
const FACTORY = 'factory:';

/** Every doc in a state, by key. Values are the state's own objects, so unchanged ones compare equal. */
export function docsOf(s: Pick<State, 'factories' | SharedKey>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const k of SHARED) m.set(k, s[k]);
  for (const f of s.factories) m.set(FACTORY + f.id, f);
  return m;
}

/** Rows to write so the cloud matches `next`, given what it last held (`prev`). Removed factories become null. */
export function changedDocs(prev: Map<string, unknown>, next: Map<string, unknown>): DocRow[] {
  const out: DocRow[] = [];
  for (const [key, data] of next) if (prev.get(key) !== data) out.push({ key, data: data ?? null });
  for (const [key, data] of prev) if (!next.has(key) && data != null) out.push({ key, data: null });
  return out;
}

/** Merge rows from the cloud into a state: shared parts are replaced, factories added, updated or removed. */
export function applyDocs(s: State, rows: DocRow[]): State {
  let next: State = { ...s };
  const upd = new Map<string, Factory | null>();
  for (const { key, data } of rows) {
    if (key.startsWith(FACTORY)) upd.set(key.slice(FACTORY.length), (data as Factory | null) ?? null);
    else if ((SHARED as readonly string[]).includes(key) && data != null) next = { ...next, [key]: data };
    else if (key === 'game') next = { ...next, game: null };
  }
  if (upd.size) {
    // Keep the order players see; new factories go at the end, oldest first.
    const kept = s.factories.flatMap((f) => (upd.has(f.id) ? (upd.get(f.id) ? [upd.get(f.id)!] : []) : [f]));
    const known = new Set(s.factories.map((f) => f.id));
    const added = [...upd.values()].filter((f): f is Factory => !!f && !known.has(f.id)).sort((a, b) => a.createdAt - b.createdAt);
    const factories = [...kept, ...added];
    const alive = new Set(factories.map((f) => f.id));
    next = {
      ...next,
      // Imports from a factory someone deleted go too, as they do locally.
      factories: factories.map((f) => (f.imports.some((i) => !alive.has(i.factoryId)) ? { ...f, imports: f.imports.filter((i) => alive.has(i.factoryId)) } : f)),
    };
    if (s.activeId && !alive.has(s.activeId)) {
      next.activeId = factories[0]?.id ?? null;
      if (!next.activeId && s.view !== 'world' && s.view !== 'account') next.view = 'progress';
    }
  }
  return next;
}
