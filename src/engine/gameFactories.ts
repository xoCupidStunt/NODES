import { isPower, itemName, items, machines, perMinute, RAW_ITEMS, recipes, WATER } from '../data/game';
import { clockPower, nodeById, nodeRate } from './plan';
import type { Unlocks } from './progression';
import type { SaveLayout } from './saveReader';
import { recipePower } from './solver';
import type { BuiltGroup, BuiltInfo, Factory } from './types';

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

interface Group { machines: Machine[]; nodes: string[]; origin?: FoundFactory['origin'] }

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
  const nodesByNet = new Map<string, string[]>();
  for (const e of layout.extractors) {
    if (!nodeById[e.node]) continue;
    nodesByNet.set(e.net, [...new Set([...(nodesByNet.get(e.net) ?? []), e.node])]);
  }
  let groups: Group[] = [...byNet].map(([net, ms]) => ({ machines: ms, nodes: nodesByNet.get(net) ?? [] }));

  for (const rule of rules.splits) {
    const i = groups.findIndex((g) => g.machines.some((m) => m.id === rule.anchor));
    if (i < 0) continue;
    const parts = splitParts(groups[i].machines, rule.gap);
    if (parts.length < 2) continue;
    // Each mined node goes to the part with the closest machine.
    const nodesFor = parts.map(() => [] as string[]);
    for (const id of groups[i].nodes) {
      const n = nodeById[id];
      let best = 0;
      let bestD = Infinity;
      parts.forEach((p, k) => {
        for (const m of p) {
          const d = Math.hypot(m.x - n.x, m.y - n.y);
          if (d < bestD) { bestD = d; best = k; }
        }
      });
      nodesFor[best].push(id);
    }
    groups.splice(i, 1, ...parts.map((p, k) => ({ machines: p, nodes: nodesFor[k], origin: { kind: 'split' as const, anchor: rule.anchor } })));
  }

  for (const anchors of rules.merges) {
    const hit = groups.filter((g) => g.machines.some((m) => anchors.includes(m.id)));
    if (hit.length < 2) continue;
    const merged: Group = {
      machines: hit.flatMap((g) => g.machines),
      nodes: [...new Set(hit.flatMap((g) => g.nodes))],
      origin: { kind: 'merged' },
    };
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
  outputs.sort((a, b) => Number(isPower(a[0])) - Number(isPower(b[0])) || (depth[b[0]] ?? 0) - (depth[a[0]] ?? 0) || b[1] * ((items[b[0]]?.sink ?? 0) || 1) - a[1] * ((items[a[0]]?.sink ?? 0) || 1));
  const [target, rate] = outputs[0];

  const nodeIds = g.nodes;
  const extraSupply: Record<string, number> = {};
  for (const [item, need] of inputs) {
    if (item === WATER) continue; // water extractors aren't tied to nodes; water is unlimited
    const mined = RAW_ITEMS.includes(item)
      ? nodeIds.map((id) => nodeById[id]).filter((n) => n.item === item).reduce((a, n) => a + nodeRate(n, u), 0)
      : 0;
    if (need - mined > 0.01) extraSupply[item] = round(need - mined);
  }

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
      bounds: {
        minX: Math.min(...ms.map((m) => m.x)), minY: Math.min(...ms.map((m) => m.y)),
        maxX: Math.max(...ms.map((m) => m.x)), maxY: Math.max(...ms.map((m) => m.y)),
      },
    },
  };
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
    bounds: bs.length ? {
      minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)),
      maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)),
    } : undefined,
  };
}

/** Fields for a new planner factory that mirrors a found one (every product it makes). */
export function factoryFromFound(ff: FoundFactory, name = ff.name): Partial<Factory> {
  return {
    name: name.trim() || ff.name,
    target: ff.target,
    rate: ff.rate,
    also: ff.built.outputs.filter(([i]) => i !== ff.target).map(([item, rate]) => ({ item, rate: round(rate) })),
    mode: 'power',
    placement: 'manual',
    location: ff.location,
    nodes: ff.nodes,
    extraSupply: ff.extraSupply,
    game: { ...ff.built, updatedAt: Date.now() },
  };
}
