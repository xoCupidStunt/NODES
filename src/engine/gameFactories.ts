import { itemName, items, machines, perMinute, RAW_ITEMS, recipes, WATER } from '../data/game';
import { clockPower, nodeById, nodeRate } from './plan';
import type { Unlocks } from './progression';
import type { SaveLayout } from './saveReader';
import { recipePower } from './solver';
import type { BuiltGroup, BuiltInfo, Factory } from './types';

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
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Group the save's machines by network and describe each group as a factory. */
export function detectFactories(layout: SaveLayout, u: Unlocks): FoundFactory[] {
  const byNet = new Map<string, SaveLayout['machines']>();
  for (const m of layout.machines) {
    if (!recipes[m.recipe]) continue; // building recipes, FICSMAS, modded…
    const list = byNet.get(m.net);
    if (list) list.push(m);
    else byNet.set(m.net, [m]);
  }
  const nodesByNet = new Map<string, string[]>();
  for (const e of layout.extractors) {
    if (!nodeById[e.node]) continue;
    const list = nodesByNet.get(e.net) ?? [];
    list.push(e.node);
    nodesByNet.set(e.net, list);
  }

  const found: FoundFactory[] = [];
  for (const [net, ms] of byNet) {
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
      const g = groups.get(r.id) ?? { recipe: r.id, count: 0, clocks: [], boosted: 0, clockMap: new Map() };
      g.count++;
      if (m.boost > 0) g.boosted++;
      const c = round(speed * 100, 4);
      g.clockMap.set(c, (g.clockMap.get(c) ?? 0) + 1);
      groups.set(r.id, g);
    }

    const outputs = Object.entries(flow).filter(([i, v]) => v > 0.01 && i !== WATER).map(([i, v]) => [i, round(v, 3)] as [string, number]);
    const inputs = Object.entries(flow).filter(([, v]) => v < -0.01).map(([i, v]) => [i, round(-v, 3)] as [string, number]);
    if (!outputs.length) continue;

    // Main product: the most processed output (deepest in this factory's chain), then the most valuable.
    const depth = itemDepths(ms.map((m) => m.recipe));
    outputs.sort((a, b) => (depth[b[0]] ?? 0) - (depth[a[0]] ?? 0) || b[1] * ((items[b[0]]?.sink ?? 0) || 1) - a[1] * ((items[a[0]]?.sink ?? 0) || 1));
    const [target, rate] = outputs[0];

    const nodeIds = [...new Set(nodesByNet.get(net) ?? [])];
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
    found.push({
      key: ms.map((m) => m.id).sort()[0],
      name: labelFor(layout.labels, ms) ?? `${itemName(target)} factory`,
      location: { x: Math.round(cx), y: Math.round(cy) },
      target,
      rate: round(rate),
      machines: ms.length,
      nodes: nodeIds,
      extraSupply,
      built: {
        machineIds: ms.map((m) => m.id),
        groups: [...groups.values()]
          .map(({ clockMap, ...g }) => ({ ...g, clocks: [...clockMap.entries()].sort((a, b) => b[1] - a[1]) }))
          .sort((a, b) => b.count - a.count),
        outputs: outputs.sort((a, b) => b[1] - a[1]),
        inputs: inputs.sort((a, b) => b[1] - a[1]),
        power: round(power, 1),
        bounds: {
          minX: Math.min(...ms.map((m) => m.x)), minY: Math.min(...ms.map((m) => m.y)),
          maxX: Math.max(...ms.map((m) => m.x)), maxY: Math.max(...ms.map((m) => m.y)),
        },
      },
    });
  }

  // Unique names.
  const seen = new Map<string, number>();
  for (const f of found.sort((a, b) => b.machines - a.machines)) {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    if (n > 1) f.name = `${f.name} ${n}`;
  }
  return found;
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

/** Which found factory each existing factory came from (by shared machines). */
export function matchFound(found: FoundFactory[], factories: Factory[]) {
  const byFound = new Map<string, Factory>();
  const byFactory = new Map<string, FoundFactory>();
  for (const f of factories) {
    if (!f.game) continue;
    const ids = new Set(f.game.machineIds);
    let best: { ff: FoundFactory; share: number } | null = null;
    for (const ff of found) {
      if (byFound.has(ff.key)) continue;
      const shared = ff.built.machineIds.filter((id) => ids.has(id)).length;
      const share = shared / Math.min(ids.size, ff.built.machineIds.length);
      if (share >= 0.5 && (!best || share > best.share)) best = { ff, share };
    }
    if (best) {
      byFound.set(best.ff.key, f);
      byFactory.set(f.id, best.ff);
    }
  }
  return { byFound, byFactory };
}

/** Fields for a new planner factory that mirrors a found one. */
export function factoryFromFound(ff: FoundFactory, name = ff.name): Partial<Factory> {
  return {
    name: name.trim() || ff.name,
    target: ff.target,
    rate: ff.rate,
    mode: 'power',
    placement: 'manual',
    location: ff.location,
    nodes: ff.nodes,
    extraSupply: ff.extraSupply,
    game: { ...ff.built, updatedAt: Date.now() },
  };
}
