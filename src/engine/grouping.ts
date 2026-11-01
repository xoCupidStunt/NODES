// Combining and separating factories — both ones found in the save and ones in the planner.
import { itemName } from '../data/game';
import { combineBuilt, detectFactories, factoryFromFound, matchFound, noRules, type FoundFactory, type GroupRules } from './gameFactories';
import { computeUnlocks, type Progress } from './progression';
import type { GameSync } from './saveSync';
import type { Factory } from './types';

export interface GroupingState {
  factories: Factory[];
  game: GameSync | null;
  progress: Progress;
  groupRules: GroupRules;
}

/** Factories found in the synced save, with the person's combine/separate rules applied. */
export function foundOf(s: Pick<GroupingState, 'game' | 'progress' | 'groupRules'>): FoundFactory[] {
  if (!s.game?.layout) return [];
  return detectFactories(s.game.layout, computeUnlocks(s.progress), s.groupRules ?? noRules);
}

/** Keep each linked factory's as-built data in step with the found factories. */
export function refreshLinked(factories: Factory[], found: FoundFactory[]): Factory[] {
  const { byFactory } = matchFound(found, factories);
  return factories.map((f) => {
    if (!f.game) return f;
    const list = byFactory.get(f.id);
    return list?.length
      ? { ...f, game: { ...combineBuilt(list.map((x) => x.built)), updatedAt: Date.now() } }
      : { ...f, game: { ...f.game, missing: true } };
  });
}

// ---------- found factories (not added yet) ----------

export function combineFound(rules: GroupRules, keys: string[]): GroupRules {
  return keys.length < 2 ? rules : { ...rules, merges: [...rules.merges, keys] };
}

export function separateFound(rules: GroupRules, key: string, gap: number): GroupRules {
  return { ...rules, splits: [...rules.splits.filter((r) => r.anchor !== key), { anchor: key, gap }] };
}

/** Put a found factory back the way the belts group it. */
export function undoFound(rules: GroupRules, ff: FoundFactory): GroupRules {
  const ids = new Set(ff.built.machineIds);
  return {
    merges: rules.merges.filter((m) => !m.some((id) => ids.has(id))),
    splits: rules.splits.filter((r) => !(ff.origin?.kind === 'split' && r.anchor === ff.origin.anchor) && !ids.has(r.anchor)),
  };
}

/** Rules that split these machines wherever they are more than `gap` metres apart (undoing combines that hold them). */
export function splitRules(s: GroupingState, machineIds: string[], gap: number): GroupRules {
  if (!s.game?.layout) return s.groupRules;
  const ids = new Set(machineIds);
  const base = { merges: s.groupRules.merges.filter((m) => !m.some((id) => ids.has(id))), splits: s.groupRules.splits };
  const before = detectFactories(s.game.layout, computeUnlocks(s.progress), base).filter((ff) => share(ff, ids) >= 0.5);
  return before.reduce((r, ff) => separateFound(r, ff.key, gap), base);
}

/** What these machines would split into at a given gap (metres). */
export function previewSplit(s: GroupingState, machineIds: string[], gap: number): FoundFactory[] {
  if (!s.game?.layout || !machineIds.length) return [];
  const ids = new Set(machineIds);
  return detectFactories(s.game.layout, computeUnlocks(s.progress), splitRules(s, machineIds, gap)).filter((ff) => share(ff, ids) >= 0.5);
}

const share = (ff: FoundFactory, ids: Set<string>) => ff.built.machineIds.filter((id) => ids.has(id)).length / ff.built.machineIds.length;

// ---------- planner factories ----------

/** Merge several planner factories into the first one. Linked game factories get a combine rule too. */
export function combineFactories(s: GroupingState, ids: string[]): Pick<GroupingState, 'factories' | 'groupRules'> {
  const list = ids.map((id) => s.factories.find((f) => f.id === id)).filter((f): f is Factory => !!f);
  if (list.length < 2) return s;
  const [p, ...rest] = list;

  const also = new Map<string, number>();
  const add = (item: string, r: number) => { if (r > 0) also.set(item, (also.get(item) ?? 0) + r); };
  let rate = p.rate;
  for (const a of p.also ?? []) add(a.item, a.rate);
  for (const o of rest) {
    const r = o.rate ?? o.game?.outputs.find(([i]) => i === o.target)?.[1] ?? 0;
    if (o.target === p.target) { if (rate !== null) rate += r; } else add(o.target, r);
    for (const a of o.also ?? []) { if (a.item === p.target) { if (rate !== null) rate += a.rate; } else add(a.item, a.rate); }
  }
  also.delete(p.target);
  const madeHere = new Set([p.target, ...also.keys()]);

  const extraSupply: Record<string, number> = {};
  for (const f of list) for (const [i, v] of Object.entries(f.extraSupply)) if (!madeHere.has(i)) extraSupply[i] = (extraSupply[i] ?? 0) + v;
  const idSet = new Set(ids);
  const importMap = new Map<string, { factoryId: string; item: string; rate: number }>();
  for (const imp of list.flatMap((f) => f.imports)) {
    if (idSet.has(imp.factoryId)) continue;
    const k = imp.factoryId + '|' + imp.item;
    const cur = importMap.get(k);
    importMap.set(k, cur ? { ...cur, rate: cur.rate + imp.rate } : { ...imp });
  }

  const linked = list.filter((f) => f.game);
  let groupRules = s.groupRules;
  if (linked.length >= 2) {
    const { byFactory } = matchFound(foundOf(s), s.factories);
    const anchors = linked.flatMap((f) => byFactory.get(f.id)?.map((ff) => ff.key) ?? []);
    groupRules = combineFound(groupRules, anchors);
  }
  const merged: Factory = {
    ...p,
    rate,
    also: [...also].map(([item, r]) => ({ item, rate: Math.round(r * 100) / 100 })),
    nodes: [...new Set(list.flatMap((f) => f.nodes))],
    extraSupply,
    imports: [...importMap.values()],
    game: linked.length ? { ...combineBuilt(linked.map((f) => f.game!)), updatedAt: Date.now() } : undefined,
  };
  const gone = new Set(rest.map((f) => f.id));
  const factories = s.factories
    .filter((f) => !gone.has(f.id))
    .map((f) => (f.id === p.id ? merged : { ...f, imports: f.imports.map((i) => (gone.has(i.factoryId) ? { ...i, factoryId: p.id } : i)).filter((i) => i.factoryId !== f.id) }));
  return { factories, groupRules };
}

/** Whether (and how) a planner factory can be separated. */
export function separateKind(f: Factory): 'game' | 'products' | null {
  if (f.game) return 'game';
  if ((f.also ?? []).length) return 'products';
  return null;
}

/**
 * Split a planner factory. Linked ones split by distance between their machines in the game;
 * others split into one factory per product.
 */
export function separateFactory(
  s: GroupingState, id: string, gap: number, make: (n: number) => Factory,
): Pick<GroupingState, 'factories' | 'groupRules'> & { activeId: string | null } {
  const f = s.factories.find((x) => x.id === id);
  if (!f) return { ...s, activeId: null };
  const keep = { mode: f.mode, clockCap: f.clockCap, useShards: f.useShards, excluded: f.excluded, schematic: f.schematic };
  let n = s.factories.length;
  const named = (base: string, used: Set<string>) => {
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base} ${k}`;
    used.add(name);
    return name;
  };
  const used = new Set(s.factories.filter((x) => x.id !== id).map((x) => x.name));

  let parts: Factory[] = [];
  let groupRules = s.groupRules;
  if (f.game) {
    const pieces = previewSplit(s, f.game.machineIds, gap);
    if (pieces.length < 2) return { ...s, activeId: f.id };
    groupRules = splitRules(s, f.game.machineIds, gap);
    parts = pieces.map((ff) => ({ ...make(++n), ...factoryFromFound(ff, named(`${f.name} – ${itemName(ff.target)}`, used)), ...keep }));
  } else if ((f.also ?? []).length) {
    parts = [
      { ...f, also: [], name: named(f.name, used) },
      ...f.also.map((a) => ({
        ...make(++n), ...keep, name: named(`${f.name} – ${itemName(a.item)}`, used),
        target: a.item, rate: a.rate, location: f.location, placement: f.placement,
      })),
    ];
  } else {
    return { ...s, activeId: f.id };
  }

  const i = s.factories.findIndex((x) => x.id === id);
  const others = s.factories.filter((x) => x.id !== id).map((x) => ({ ...x, imports: x.imports.filter((imp) => imp.factoryId !== id || parts[0].id === id) }));
  others.splice(i, 0, ...parts);
  return { factories: others, groupRules, activeId: parts[0].id };
}
