import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { buildPlan, type Plan } from './engine/plan';
import { defaultProgress, type Progress } from './engine/progression';
import { defaultSchematic, type Factory } from './engine/types';

export type View = 'progress' | 'setup' | 'results' | 'map' | 'schematic';

interface State {
  progress: Progress;
  factories: Factory[];
  activeId: string | null;
  view: View;
}

type Action =
  | { type: 'progress'; patch: Partial<Progress> }
  | { type: 'add'; factory: Factory }
  | { type: 'update'; id: string; patch: Partial<Factory> }
  | { type: 'remove'; id: string }
  | { type: 'select'; id: string | null; view?: View }
  | { type: 'view'; view: View }
  | { type: 'load'; state: State };

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
    case 'select':
      return { ...s, activeId: a.id, view: a.view ?? (s.view === 'progress' ? 'setup' : s.view) };
    case 'view':
      return { ...s, view: a.view };
    case 'load':
      return a.state;
  }
}

export function newFactory(n: number): Factory {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: `Factory ${n}`,
    target: 'Desc_IronPlateReinforced_C',
    rate: 10,
    mode: 'max',
    placement: 'suggested',
    location: null,
    nodes: [],
    extraSupply: {},
    imports: [],
    excluded: [],
    unlimitedRaw: false,
    clockCap: 100,
    useShards: false,
    schematic: { ...defaultSchematic },
    createdAt: Date.now(),
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      // Fill in fields added in later versions.
      s.progress = { ...defaultProgress, ...s.progress };
      s.factories = s.factories.map((f) => ({ ...newFactory(0), ...f, schematic: { ...defaultSchematic, ...f.schematic } }));
      return { ...s, view: s.view ?? 'setup' };
    }
  } catch {
    /* ignore broken storage */
  }
  return { progress: defaultProgress, factories: [], activeId: null, view: 'progress' };
}

interface Ctx {
  state: State;
  dispatch: (a: Action) => void;
  active: Factory | null;
  plans: Record<string, Plan>;
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
  const plans = useMemo(() => {
    const out: Record<string, Plan> = {};
    for (const f of state.factories) out[f.id] = buildPlan(f, state.progress);
    return out;
  }, [state.factories, state.progress]);
  const active = state.factories.find((f) => f.id === state.activeId) ?? null;
  const value = useMemo(() => ({ state, dispatch, active, plans }), [state, active, plans]);
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
