import { extractors, isPower, itemName, items, machines, perMinute, PURITY_MULT, RAW_ITEMS, recipes, WATER } from '../data/game';
import { clockPower, nodeById, nodeRate } from './plan';
import type { Unlocks } from './progression';
import type { SaveLayout } from './saveReader';
import { recipePower } from './solver';
import type { BuiltExtractor, BuiltGroup, BuiltInfo, Factory } from './types';

type Machine = SaveLayout['machines'][number];

/** A factory found in the save: production machines joined by belts and pipes. */
export interface FoundFactory {
  key: string;
  name: string;
  location: { x: number; y: number };
  target: string;
  /** Net output of the main product per minute, at the clocks set in game. */
  rate: number;
  machines: number;
  /** Resource nodes mined by extractors on the same belt/pipe network. */
  nodes: string[];
  /** Inputs that arrive from outside the network (trains, trucks, other factories). */
  extraSupply: Record<string, number>;
  built: Omit<BuiltInfo, 'updatedAt'>;
  /** Set when the person combined or separated factories. */
  origin?: { kind: 'merged' } | { kind: 'split'; anchor: string };
}

/**
 * How the person wants game factories grouped, on top of the belt networks.
 * Rules point at machine ids, so they keep working as the save changes.
 */
export interface GroupRules {
  /** Each entry: one machine from each factory to combine. */
  merges: string[][];
  /** Split the factory containing `anchor` wherever machines are more than `gap` metres apart. */
  splits: { anchor: string; gap: number }[];
}
export const noRules: GroupRules = { merges: [], splits: [] };

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

type Ex = SaveLayout['extractors'][number];
interface Group { machines: Machine[]; extractors: Ex[]; nodes: string[]; origin?: FoundFactory['origin'] }

/** Map nodes mined by these extractors. */
const nodesOf = (exs: Ex[]) => [...new Set(exs.map((e) => e.node).filter((id) => nodeById[id]))];

/** Extractor building of a saved extractor (older saves only kept the id, which contains it). */
export const extractorType = (e: Ex) => e.type ?? e.id.match(/(Build_[A-Za-z0-9]+_C)_d+$/)?.[1] ?? '';

/** Where an extractor stands: its own position, else the node it sits on. */
const exAt = (e: Ex) => (e.x !== undefined && e.y !== undefined ? { x: e.x, y: e.y } : nodeById[e.node] ?? null);

/** The game-data recipe a saved machine runs. Generators are saved as "GEN|<building>|<fuel or geyser node>". */
function resolveRecipe(m: Machine): string | null {
  if (!m.recipe.startsWith('GEN|')) return recipes[m.recipe] ? m.recipe : null;
  const [, gen, what] = m.recipe.split('|');
  if (gen === 'Build_GeneratorGeoThermal_C') return `Power_${gen}_${nodeById[what]?.purity ?? 'normal'}`;
  const id = `Power_${gen}_${what}`;
  if (recipes[id]) return id;
  return Object.keys(recipes).find((r) => r.startsWith(`Power_${gen}_`)) ?? null; // idle generator: assume its first fuel
}

/** Machines → groups: belt/pipe networks, then the person's splits, then their merges. */
export function groupMachines(layout: SaveLayout, rules: GroupRules = noRules): Group[] {
  const byNet = new Map<string, Machine[]>();
  for (const raw of layout.machines) {
    const recipe = resolveRecipe(raw);
    if (!recipe) continue; // building recipes, FICSMAS, modded…
    const m = recipe === raw.recipe ? raw : { ...raw, recipe };
    byNet.set(m.net, [...(byNet.get(m.net) ?? []), m]);
  }
  const exByNet = new Map<string, Ex[]>();
  for (const e of layout.extractors) {
    if (!extractors[extractorType(e)]) continue;
    exByNet.set(e.net, [...(exByNet.get(e.net) ?? []), e]);
  }
  let groups: Group[] = [...byNet].map(([net, ms]) => {
    const exs = exByNet.get(net) ?? [];
    return { machines: ms, extractors: exs, nodes: nodesOf(exs) };
  });

  for (const rule of rules.splits) {
    const i = groups.findIndex((g) => g.machines.some((m) => m.id === rule.anchor));
    if (i < 0) continue;
    const parts = splitParts(groups[i].machines, rule.gap);
    if (parts.length < 2) continue;
    // Each extractor goes to the part with the closest machine.
    const exFor = parts.map(() => [] as Ex[]);
    for (const e of groups[i].extractors) {
      const at = exAt(e);
      let best = 0;
      let bestD = Infinity;
      if (at) {
        parts.forEach((p, k) => {
          for (const m of p) {
            const d = Math.hypot(m.x - at.x, m.y - at.y);
            if (d < bestD) { bestD = d; best = k; }
          }
        });
      }
      exFor[best].push(e);
    }
    groups.splice(i, 1, ...parts.map((p, k) => ({ machines: p, extractors: exFor[k], nodes: nodesOf(exFor[k]), origin: { kind: 'split' as const, anchor: rule.anchor } })));
  }

  for (const anchors of rules.merges) {
    const hit = groups.filter((g) => g.machines.some((m) => anchors.includes(m.id)));
    if (hit.length < 2) continue;
    const exs = hit.flatMap((g) => g.extractors);
    const merged: Group = { machines: hit.flatMap((g) => g.machines), extractors: exs, nodes: nodesOf(exs), origin: { kind: 'merged' } };
    groups = [...groups.filter((g) => !hit.includes(g)), merged];
  }
  return groups;
}

/** Split machines into clusters: machines closer than `gap` metres end up together. */
export function splitParts(ms: Machine[], gap: number): Machine[][] {
  const parent = ms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const lim = gap * 100;
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      if (Math.abs(ms[i].x - ms[j].x) > lim || Math.abs(ms[i].y - ms[j].y) > lim) continue;
      if (Math.hypot(ms[i].x - ms[j].x, ms[i].y - ms[j].y) <= lim) parent[find(i)] = find(j);
    }
  }
  const parts = new Map<number, Machine[]>();
  ms.forEach((m, i) => parts.set(find(i), [...(parts.get(find(i)) ?? []), m]));
  return [...parts.values()].sort((a, b) => b.length - a.length);
}

/** Describe a group of machines as a factory: product, rates, power, inputs. */
export function describeGroup(g: Group, labels: SaveLayout['labels'], u: Unlocks): FoundFactory | null {
  const ms = g.machines;
  if (!ms.length) return null;
  // Net flow per item at the in-game clocks (somersloops multiply output only).
  const flow: Record<string, number> = {};
  const groups = new Map<string, BuiltGroup & { clockMap: Map<number, number> }>();
  let power = 0;
  for (const m of ms) {
    const r = recipes[m.recipe];
    const speed = m.clock;
    for (const [i, a] of r.in) flow[i] = (flow[i] ?? 0) - perMinute(r, a) * speed;
    for (const [i, a] of r.out) flow[i] = (flow[i] ?? 0) + perMinute(r, a) * speed * (1 + m.boost);
    const mach = machines[r.machine];
    power += clockPower(recipePower(r), mach?.exp ?? 1.321929, speed * 100) * (1 + m.boost) ** (mach?.boostExp ?? 2);
    const bg = groups.get(r.id) ?? { recipe: r.id, count: 0, clocks: [], boosted: 0, clockMap: new Map() };
    bg.count++;
    if (m.boost > 0) bg.boosted++;
    const c = round(speed * 100, 4);
    bg.clockMap.set(c, (bg.clockMap.get(c) ?? 0) + 1);
    groups.set(r.id, bg);
  }

  const outputs = Object.entries(flow).filter(([i, v]) => v > 0.01 && i !== WATER).map(([i, v]) => [i, round(v, 3)] as [string, number]);
  const inputs = Object.entries(flow).filter(([, v]) => v < -0.01).map(([i, v]) => [i, round(-v, 3)] as [string, number]);
  if (!outputs.length) return null;

  // Main product: the most processed output (deepest in this factory's chain), then the most valuable.
  // Power is only the main product of a pure power plant.
  const depth = itemDepths(ms.map((m) => m.recipe));
    // Surplus (an ingredient here that is over-made) comes last of all.
  const extra = surplusItems({ groups: [...groups.values()].map(({ clockMap, ...x }) => ({ ...x, clocks: [...clockMap.entries()] })), outputs });
  const rank = (i: string) => (extra.has(i) ? 2 : isPower(i) ? 1 : 0);
  outputs.sort((a, b) => rank(a[0]) - rank(b[0]) || (depth[b[0]] ?? 0) - (depth[a[0]] ?? 0) || b[1] * ((items[b[0]]?.sink ?? 0) || 1) - a[1] * ((items[a[0]]?.sink ?? 0) || 1));
  const [target, rate] = outputs[0];

  const nodeIds = g.nodes;
  const exGroups = describeExtractors(g.extractors);
  // Raw resources without an extractor on this network: fall back to the best rate of its claimed nodes.
  const nodeFallback: Record<string, number> = {};
  for (const id of nodeIds) {
    const n = nodeById[id];
    if (n && !exGroups.some((x) => x.item === n.item)) nodeFallback[n.item] = (nodeFallback[n.item] ?? 0) + nodeRate(n, u);
  }
  const extraSupply = outsideSupplyOf({ groups: [...groups.values()].map(({ clockMap, ...x }) => ({ ...x, clocks: [...clockMap.entries()] })), inputs, extractors: exGroups }, {}, nodeFallback);

  const cx = ms.reduce((a, m) => a + m.x, 0) / ms.length;
  const cy = ms.reduce((a, m) => a + m.y, 0) / ms.length;
  return {
    key: ms.map((m) => m.id).sort()[0],
    name: labelFor(labels, ms) ?? (isPower(target) ? powerPlantName(ms) : `${itemName(target)} factory`),
    location: { x: Math.round(cx), y: Math.round(cy) },
    target,
    rate: round(rate),
    machines: ms.length,
    nodes: nodeIds,
    extraSupply,
    origin: g.origin,
    built: {
      machineIds: ms.map((m) => m.id),
      groups: [...groups.values()]
        .map(({ clockMap, ...x }) => ({ ...x, clocks: [...clockMap.entries()].sort((a, b) => b[1] - a[1]) }))
        .sort((a, b) => b.count - a.count),
      outputs: outputs.sort((a, b) => b[1] - a[1]),
      inputs: inputs.sort((a, b) => b[1] - a[1]),
      power: round(power, 1),
      extractors: exGroups,
      bounds: {
        minX: Math.min(...ms.map((m) => m.x)), minY: Math.min(...ms.map((m) => m.y)),
        maxX: Math.max(...ms.map((m) => m.x)), maxY: Math.max(...ms.map((m) => m.y)),
      },
    },
  };
}

/**
 * What really comes from outside a built factory: items its machines use but none of them make, and raw
 * resources beyond what its own extractors deliver. Items made inside but used faster than they are made
 * are a shortfall, not outside supply (see shortfallsOf). Water is pumped on site, so never counted.
 * `previous` keeps raw entries when older data has no extractor list.
 */
export function outsideSupplyOf(
  built: Pick<BuiltInfo, 'groups' | 'inputs' | 'extractors'>,
  previous: Record<string, number> = {},
  mined: Record<string, number> = {},
): Record<string, number> {
  const made = madeInside(built);
  const own: Record<string, number> = { ...mined };
  for (const x of built.extractors ?? []) if (x.item) own[x.item] = (own[x.item] ?? 0) + x.rate;
  const out: Record<string, number> = {};
  for (const [item, need] of built.inputs) {
    if (item === WATER || made.has(item)) continue;
    if (RAW_ITEMS.includes(item)) {
      if (!built.extractors) { if (previous[item]) out[item] = previous[item]; continue; }
      const short = need - (own[item] ?? 0);
      if (short > 0.01) out[item] = round(short);
    } else out[item] = round(need);
  }
  return out;
}

/** Items made by a built factory's own machines. */
export const madeInside = (built: Pick<BuiltInfo, 'groups'>) => new Set(built.groups.flatMap((g) => recipes[g.recipe]?.out.map(([i]) => i) ?? []));

/** Items made inside but used faster than they're made (per minute short, at the in-game clocks). */
export function shortfallsOf(built: Pick<BuiltInfo, 'groups' | 'inputs'>): [string, number][] {
  const made = madeInside(built);
  return built.inputs.filter(([i, v]) => made.has(i) && v > 0.01);
}

/** Extractors summed by kind and resource, with output and power at their in-game clocks. */
export function describeExtractors(exs: Ex[]): BuiltExtractor[] {
  const out = new Map<string, BuiltExtractor & { clockMap: Map<number, number> }>();
  for (const e of exs) {
    const type = extractorType(e);
    const x = extractors[type];
    if (!x) continue;
    const node = nodeById[e.node];
    const item = x.kind === 'water' ? WATER : x.kind === 'pressurizer' ? '' : node?.item ?? '';
    if (x.kind !== 'water' && x.kind !== 'pressurizer' && !item) continue;
    const mult = node ? PURITY_MULT[node.purity] : 1;
    const key = type + '|' + item;
    const cur = out.get(key) ?? { type, item, count: 0, clocks: [], rate: 0, power: 0, clockMap: new Map<number, number>() };
    cur.count++;
    cur.rate += x.rate * mult * e.clock;
    cur.power += x.power * Math.pow(e.clock, 1.321929);
    const c = round(e.clock * 100, 4);
    cur.clockMap.set(c, (cur.clockMap.get(c) ?? 0) + 1);
    out.set(key, cur);
  }
  return [...out.values()]
    .map(({ clockMap, ...x }) => ({ ...x, rate: round(x.rate, 3), power: round(x.power, 2), clocks: [...clockMap.entries()].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.count - a.count);
}

/** Merge extractor lists of several factories. */
function mergeExtractors(lists: BuiltExtractor[][]): BuiltExtractor[] {
  const out = new Map<string, BuiltExtractor & { clockMap: Map<number, number> }>();
  for (const x of lists.flat()) {
    const key = x.type + '|' + x.item;
    const cur = out.get(key) ?? { ...x, count: 0, rate: 0, power: 0, clocks: [], clockMap: new Map<number, number>() };
    cur.count += x.count;
    cur.rate += x.rate;
    cur.power += x.power;
    for (const [c, n] of x.clocks) cur.clockMap.set(c, (cur.clockMap.get(c) ?? 0) + n);
    out.set(key, cur);
  }
  return [...out.values()].map(({ clockMap, ...x }) => ({ ...x, clocks: [...clockMap.entries()].sort((a, b) => b[1] - a[1]) }));
}

/** Group the save's machines and describe each group as a factory. */
export function detectFactories(layout: SaveLayout, u: Unlocks, rules: GroupRules = noRules): FoundFactory[] {
  const found = groupMachines(layout, rules)
    .map((g) => describeGroup(g, layout.labels, u))
    .filter((f): f is FoundFactory => !!f);
  // Unique names.
  const seen = new Map<string, number>();
  for (const f of found.sort((a, b) => b.machines - a.machines)) {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    if (n > 1) f.name = `${f.name} ${n}`;
  }
  return found;
}

/** "Coal power plant", "Geothermal plant"… from the generators' most common fuel. */
function powerPlantName(ms: Machine[]) {
  const count = new Map<string, number>();
  for (const m of ms) if (recipes[m.recipe]?.generator) count.set(m.recipe, (count.get(m.recipe) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!top) return 'Power plant';
  if (top.includes('GeoThermal')) return 'Geothermal plant';
  const fuel = recipes[top].in[0]?.[0];
  return fuel ? `${itemName(fuel)} power plant` : 'Power plant';
}

/** How many processing steps it takes to make each item from this set of recipes. */
function itemDepths(recipeIds: string[]) {
  const makers = new Map<string, string[]>();
  for (const id of new Set(recipeIds)) for (const [i] of recipes[id].out) makers.set(i, [...(makers.get(i) ?? []), id]);
  const depth: Record<string, number> = {};
  const visit = (item: string, stack: Set<string>): number => {
    if (depth[item] !== undefined) return depth[item];
    if (!makers.has(item) || stack.has(item)) return 0;
    stack.add(item);
    let d = 0;
    for (const r of makers.get(item)!) for (const [i] of recipes[r].in) d = Math.max(d, visit(i, stack));
    stack.delete(item);
    return (depth[item] = d + 1);
  };
  for (const item of makers.keys()) visit(item, new Set());
  return depth;
}

/** A station or named map marker close to the factory's machines. */
function labelFor(labels: SaveLayout['labels'], ms: SaveLayout['machines']) {
  let best: { name: string; d: number } | null = null;
  for (const l of labels) {
    let d = Infinity;
    for (const m of ms) d = Math.min(d, Math.hypot(m.x - l.x, m.y - l.y));
    const limit = l.kind === 'station' ? 8000 : 15000; // cm: 80 m to a station, 150 m to a marker
    if (d > limit) continue;
    const score = d + (l.kind === 'marker' ? 0 : 5000); // a named marker beats a station name
    if (!best || score < best.d) best = { name: l.name, d: score };
  }
  return best?.name ?? null;
}

/**
 * Which planner factory each found factory belongs to: the one holding at least half of its machines.
 * A planner factory can cover several found factories (when they were combined in the planner).
 */
export function matchFound(found: FoundFactory[], factories: Factory[]) {
  const byFound = new Map<string, Factory>();
  const byFactory = new Map<string, FoundFactory[]>();
  const sets = factories.filter((f) => f.game).map((f) => ({ f, ids: new Set(f.game!.machineIds) }));
  for (const ff of found) {
    let best: { f: Factory; share: number } | null = null;
    for (const { f, ids } of sets) {
      const share = ff.built.machineIds.filter((id) => ids.has(id)).length / ff.built.machineIds.length;
      if (share >= 0.5 && (!best || share > best.share)) best = { f, share };
    }
    if (best) {
      byFound.set(ff.key, best.f);
      byFactory.set(best.f.id, [...(byFactory.get(best.f.id) ?? []), ff]);
    }
  }
  return { byFound, byFactory };
}

/** One as-built record for several found factories (net flows recomputed). */
export function combineBuilt(list: Omit<BuiltInfo, 'updatedAt'>[]): Omit<BuiltInfo, 'updatedAt'> {
  if (list.length === 1) return list[0];
  const flow: Record<string, number> = {};
  for (const b of list) {
    for (const [i, v] of b.outputs) flow[i] = (flow[i] ?? 0) + v;
    for (const [i, v] of b.inputs) flow[i] = (flow[i] ?? 0) - v;
  }
  const groups = new Map<string, BuiltGroup & { clockMap: Map<number, number> }>();
  for (const b of list) {
    for (const g of b.groups) {
      const x = groups.get(g.recipe) ?? { recipe: g.recipe, count: 0, clocks: [], boosted: 0, clockMap: new Map() };
      x.count += g.count;
      x.boosted += g.boosted;
      for (const [c, n] of g.clocks) x.clockMap.set(c, (x.clockMap.get(c) ?? 0) + n);
      groups.set(g.recipe, x);
    }
  }
  const bs = list.map((b) => b.bounds).filter((b): b is NonNullable<typeof b> => !!b);
  return {
    machineIds: list.flatMap((b) => b.machineIds),
    groups: [...groups.values()].map(({ clockMap, ...x }) => ({ ...x, clocks: [...clockMap.entries()].sort((a, b) => b[1] - a[1]) })).sort((a, b) => b.count - a.count),
    outputs: Object.entries(flow).filter(([, v]) => v > 0.01).map(([i, v]) => [i, round(v, 3)] as [string, number]).sort((a, b) => b[1] - a[1]),
    inputs: Object.entries(flow).filter(([, v]) => v < -0.01).map(([i, v]) => [i, round(-v, 3)] as [string, number]).sort((a, b) => b[1] - a[1]),
    power: round(list.reduce((a, b) => a + b.power, 0), 1),
    extractors: mergeExtractors(list.map((b) => b.extractors ?? [])),
    bounds: bs.length ? {
      minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)),
      maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)),
    } : undefined,
  };
}

/**
 * Items a built factory makes more of than it uses, although it uses them itself (e.g. fuel made by refineries
 * and burnt by generators in the same factory). The extra either leaves by some other route or backs up.
 */
export function surplusItems(built: Pick<BuiltInfo, 'groups' | 'outputs'>): Set<string> {
  const used = new Set<string>();
  const made: Record<string, number> = {};
  for (const g of built.groups) {
    const r = recipes[g.recipe];
    if (!r) continue;
    const speed = g.clocks.reduce((a, [c, n]) => a + (c / 100) * n, 0);
    for (const [i] of r.in) used.add(i);
    for (const [i, a] of r.out) made[i] = (made[i] ?? 0) + perMinute(r, a) * speed;
  }
  // Used here, and only a small share of what's made is left: a leftover. A large share left means it's shipped out.
  return new Set(built.outputs.filter(([i, left]) => used.has(i) && !isPower(i) && made[i] > 0 && left / made[i] <= SURPLUS_SHARE).map(([i]) => i));
}
/** At most this share of what's made may be left over for an item to count as surplus rather than a product. */
export const SURPLUS_SHARE = 0.25;
export const isSurplus = (built: Pick<BuiltInfo, 'groups' | 'outputs'>, item: string) => surplusItems(built).has(item);

/** Fields for a new planner factory that mirrors a found one (its products, not its surplus). */
export function factoryFromFound(ff: FoundFactory, name = ff.name): Partial<Factory> {
  return {
    name: name.trim() || ff.name,
    target: ff.target,
    rate: ff.rate,
    also: ff.built.outputs.filter(([i]) => i !== ff.target && !isSurplus(ff.built, i)).map(([item, rate]) => ({ item, rate: round(rate) })),
    mode: 'power',
    placement: 'manual',
    location: ff.location,
    nodes: ff.nodes,
    extraSupply: ff.extraSupply,
    game: { ...ff.built, updatedAt: Date.now() },
  };
}
