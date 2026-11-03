import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { buildPlan, type Plan } from './engine/plan';
import { defaultProgress, type Progress } from './engine/progression';
import { defaultSchematic, type Factory } from './engine/types';
import type { GameSync } from './engine/saveSync';
import { noRules, type FoundFactory, type GroupRules } from './engine/gameFactories';
import { combineFactories, combineFound, foundOf, refreshLinked, separateFactory, splitRules, undoFound, withGameSupply, withPowerProduct } from './engine/grouping';

export type View = 'progress' | 'world' | 'built' | 'setup' | 'results' | 'map' | 'schematic';

/** Something to centre the world map on. */
export type MapFocus = { kind: 'found' | 'factory'; id: string } | null;

interface State {
  progress: Progress;
  factories: Factory[];
  activeId: string | null;
  view: View;
  /** Last save synced from the game, if any. */
  game: GameSync | null;
  /** Save-sync settings: which game session to follow, and whether to sync on its own. */
  sync: { session: string | null; auto: boolean };
  /** Names given to factories found in the save before they are added. */
  foundNames: Record<string, string>;
  mapFocus: MapFocus;
  /** How the person combined or separated factories found in the save. */
  groupRules: GroupRules;
}

type Action =
  | { type: 'progress'; patch: Partial<Progress> }
  | { type: 'add'; factory: Factory }
  | { type: 'update'; id: string; patch: Partial<Factory> }
  | { type: 'remove'; id: string }
  | { type: 'select'; id: string | null; view?: View }
  | { type: 'view'; view: View }
  | { type: 'load'; state: State }
  | { type: 'gameSync'; progress: Progress; game: GameSync }
  | { type: 'syncPrefs'; patch: Partial<State['sync']> }
  | { type: 'forgetGame' }
  | { type: 'addMany'; factories: Factory[] }
  | { type: 'renameFound'; key: string; name: string }
  | { type: 'showOnMap'; focus: MapFocus }
  | { type: 'combineFound'; keys: string[] }
  | { type: 'separateFound'; machineIds: string[]; gap: number }
  | { type: 'undoFound'; found: FoundFactory }
  | { type: 'combineFactories'; ids: string[] }
  | { type: 'separateFactory'; id: string; gap: number };

const KEY = 'ficsit-planner-v1';

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'progress':
      return { ...s, progress: { ...s.progress, ...a.patch } };
    case 'add':
      return { ...s, factories: [...s.factories, a.factory], activeId: a.factory.id, view: 'setup' };
    case 'update':
      return { ...s, factories: s.factories.map((f) => (f.id === a.id ? { ...f, ...a.patch } : f)) };
    case 'remove': {
      const factories = s.factories.filter((f) => f.id !== a.id);
      return {
        ...s,
        factories: factories.map((f) => ({ ...f, imports: f.imports.filter((i) => i.factoryId !== a.id) })),
        activeId: s.activeId === a.id ? factories[0]?.id ?? null : s.activeId,
      };
    }
    case 'select': {
      // Factories built in the game open on their overview; planned ones on the planner steps.
      const f = s.factories.find((x) => x.id === a.id);
      const fallback = f?.game ? 'built' : s.view === 'progress' || s.view === 'world' || s.view === 'built' ? 'setup' : s.view;
      return { ...s, activeId: a.id, view: a.view ?? fallback };
    }
    case 'view':
      return { ...s, view: a.view };
    case 'load':
      return a.state;
    case 'gameSync': {
      // Refresh the as-built data of factories added from the game.
      const next = { ...s, progress: a.progress, game: a.game };
      return { ...next, factories: refreshLinked(s.factories, foundOf(next)) };
    }
    case 'combineFound':
      return { ...s, groupRules: combineFound(s.groupRules, a.keys) };
    case 'separateFound':
      return { ...s, groupRules: splitRules(s, a.machineIds, a.gap) };
    case 'undoFound':
      return { ...s, groupRules: undoFound(s.groupRules, a.found) };
    case 'combineFactories': {
      const r = combineFactories(s, a.ids);
      const next = { ...s, ...r, activeId: a.ids[0] };
      return { ...next, factories: refreshLinked(next.factories, foundOf(next)) };
    }
    case 'separateFactory': {
      const r = separateFactory(s, a.id, a.gap, newFactory);
      const next = { ...s, factories: r.factories, groupRules: r.groupRules, activeId: r.activeId };
      return { ...next, factories: refreshLinked(next.factories, foundOf(next)) };
    }
    case 'addMany':
      return { ...s, factories: [...s.factories, ...a.factories] };
    case 'renameFound':
      return { ...s, foundNames: { ...s.foundNames, [a.key]: a.name } };
    case 'showOnMap':
      return { ...s, view: 'world', mapFocus: a.focus };
    case 'syncPrefs':
      return { ...s, sync: { ...s.sync, ...a.patch } };
    case 'forgetGame':
      return { ...s, game: null };
  }
}

/** Planned factories: "as much as possible" maximises; a target rate is hit with the least power. */
const plannedMode = (f: Factory): Factory => (f.game ? f : { ...f, mode: f.rate === null ? 'max' : f.mode === 'max' ? 'power' : f.mode });

/** Power shards not already in a machine: owned minus slotted, from the last synced save (owned if not synced). */
export function spareShards(s: { progress: Progress; game: { shards: { total: number; slotted: number } } | null }) {
  return Math.max(0, s.progress.shards - (s.game?.shards.slotted ?? 0));
}

export function newFactory(n: number): Factory {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: `Factory ${n}`,
    target: 'Desc_IronPlateReinforced_C',
    rate: 10,
    mode: 'power',
    placement: 'suggested',
    location: null,
    nodes: [],
    extraSupply: {},
    also: [],
    imports: [],
    excluded: [],
    unlimitedRaw: false,
    clockCap: 100,
    useShards: false,
    schematic: { ...defaultSchematic },
    createdAt: Date.now(),
  };
}

const defaultSync: State['sync'] = { session: null, auto: true };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      // Fill in fields added in later versions.
      s.progress = { ...defaultProgress, ...s.progress };
      s.factories = s.factories.map((f) => withGameSupply(withPowerProduct(plannedMode({ ...newFactory(0), ...f, schematic: { ...defaultSchematic, ...f.schematic } }))));
      // Older saves stored found factories instead of the layout; resync to fill it in.
      if (s.game && !s.game.layout) s.game.layout = { machines: [], extractors: [], labels: [] };
      return { ...s, view: s.view ?? 'setup', game: s.game ?? null, foundNames: s.foundNames ?? {}, mapFocus: null, groupRules: s.groupRules ?? noRules, sync: { ...defaultSync, ...s.sync } };
    }
  } catch {
    /* ignore broken storage */
  }
  return { progress: defaultProgress, factories: [], activeId: null, view: 'progress', game: null, sync: defaultSync, foundNames: {}, mapFocus: null, groupRules: noRules };
}

interface Ctx {
  state: State;
  dispatch: (a: Action) => void;
  active: Factory | null;
  plans: Record<string, Plan>;
  /** Progress with only the spare power shards (owned minus those slotted in machines in the game). */
  planProgress: Progress;
  /** Factories found in the synced save (with combine/separate rules applied). */
  found: FoundFactory[];
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage full or blocked */
    }
  }, [state]);
  // Shards already in machines in the game aren't free: plans only get the spare ones.
  const planProgress = useMemo(() => ({ ...state.progress, shards: spareShards(state) }), [state.progress, state.game]); // eslint-disable-line react-hooks/exhaustive-deps
  const plans = useMemo(() => {
    const out: Record<string, Plan> = {};
    for (const f of state.factories) out[f.id] = buildPlan(f, planProgress);
    return out;
  }, [state.factories, planProgress]);
  const found = useMemo(() => foundOf(state), [state.game, state.progress, state.groupRules]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = state.factories.find((f) => f.id === state.activeId) ?? null;
  const value = useMemo(() => ({ state, dispatch, active, plans, found, planProgress }), [state, active, plans, found, planProgress]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('useStore outside provider');
  return c;
}

export function exportState(s: State) {
  return JSON.stringify({ progress: s.progress, factories: s.factories }, null, 2);
}
export function parseImport(text: string): Pick<State, 'progress' | 'factories'> {
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.factories) || !j.progress) throw new Error('Not a N.O.D.E.S export file');
  return { progress: { ...defaultProgress, ...j.progress }, factories: j.factories };
}
