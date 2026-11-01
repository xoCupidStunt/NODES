import { nodes, WATER, WORLD, type ResourceNode } from '../data/game';
import { buildPlan, nodeRate, type Plan } from './plan';
import { computeUnlocks, type Progress, type Unlocks } from './progression';
import type { Factory } from './types';

export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) / 100; // metres

/** Raw resources (excluding water) this factory would need, ignoring which nodes are claimed. */
export function rawDemand(f: Factory, progress: Progress, current?: Plan): Record<string, number> {
  const rate = f.rate ?? (current && current.rate > 0 ? current.rate : null) ?? 10;
  const p = buildPlan({ ...f, rate, mode: f.mode === 'max' ? 'power' : f.mode, nodes: [], extraSupply: {}, unlimitedRaw: true }, progress);
  const d: Record<string, number> = {};
  for (const [item, v] of Object.entries(p.solve.inputs)) {
    if (item === WATER) continue;
    const imported = f.imports.filter((i) => i.item === item).reduce((a, b) => a + b.rate, 0);
    if (v - imported > 1e-6) d[item] = v - imported;
  }
  return d;
}

/** Nodes this factory should not take: claimed by other factories, plus any already mined in the game. */
export function claimedElsewhere(factories: Factory[], selfId: string, inGame: Iterable<string> = []) {
  const s = new Set<string>(inGame);
  for (const f of factories) if (f.id !== selfId) f.nodes.forEach((n) => s.add(n));
  return s;
}

/** Closest free nodes of an item to a point, nearest first. */
export function nearestNodes(item: string, at: { x: number; y: number }, taken: Set<string>, limit = 8) {
  return nodes
    .filter((n) => n.item === item && !taken.has(n.id) && n.type !== 'geyser')
    .map((n) => ({ node: n, d: dist(n, at) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}

/** Greedy: for each needed resource take the nearest free nodes until the demand is covered. */
export function pickNodes(demand: Record<string, number>, at: { x: number; y: number }, taken: Set<string>, u: Unlocks) {
  const picked: ResourceNode[] = [];
  let cost = 0;
  let weight = 0;
  let short = 0;
  for (const [item, need] of Object.entries(demand)) {
    let left = need;
    const candidates = nodes.filter((n) => n.item === item && !taken.has(n.id) && n.type !== 'geyser');
    candidates.sort((a, b) => dist(a, at) - dist(b, at));
    for (const n of candidates) {
      if (left <= 1e-6) break;
      const r = nodeRate(n, u);
      if (r <= 0) continue;
      const use = Math.min(left, r);
      picked.push(n);
      cost += use * dist(n, at);
      weight += use;
      left -= use;
    }
    if (left > 1e-6) short += left;
  }
  return { picked, avgDistance: weight ? cost / weight : 0, short };
}

export interface Suggestion {
  location: { x: number; y: number };
  nodes: string[];
  avgDistance: number;
  short: number;
}

/**
 * Best spot = smallest belt-distance per item moved. Imports from other factories pull the spot towards them.
 * Coarse grid scan, then a finer scan around the winner.
 */
export function suggestLocation(f: Factory, factories: Factory[], progress: Progress, current?: Plan, inGame: Iterable<string> = []): Suggestion | null {
  const u = computeUnlocks(progress);
  const demand = rawDemand(f, progress, current);
  const taken = claimedElsewhere(factories, f.id, inGame);
  const pulls = f.imports
    .map((i) => ({ at: factories.find((x) => x.id === i.factoryId)?.location, rate: i.rate }))
    .filter((p): p is { at: { x: number; y: number }; rate: number } => !!p.at);
  if (!Object.keys(demand).length && !pulls.length) return null;

  const score = (at: { x: number; y: number }) => {
    const p = pickNodes(demand, at, taken, u);
    let cost = p.avgDistance * Object.values(demand).reduce((a, b) => a + b, 0);
    for (const pl of pulls) cost += dist(pl.at, at) * pl.rate;
    cost += p.short * 5000; // strongly avoid spots that can't be fully supplied
    return { cost, p };
  };

  let best: { at: { x: number; y: number }; cost: number } | null = null;
  const step = 20000;
  // Candidate points: a coarse grid plus every relevant node position.
  const candidates: { x: number; y: number }[] = [];
  for (let x = WORLD.minX + step / 2; x < WORLD.maxX; x += step) for (let y = WORLD.minY + step / 2; y < WORLD.maxY; y += step) candidates.push({ x, y });
  for (const n of nodes) if (demand[n.item] && !taken.has(n.id)) candidates.push({ x: n.x, y: n.y });
  // Only consider grid points reasonably close to at least one needed node (land, not ocean).
  const relevant = nodes.filter((n) => demand[n.item]);
  for (const c of candidates) {
    if (relevant.length && !relevant.some((n) => dist(n, c) < 600)) continue;
    const s = score(c);
    if (!best || s.cost < best.cost) best = { at: c, cost: s.cost };
  }
  if (!best) return null;
  for (let s = step / 2; s >= 1000; s /= 2) {
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
      const c: { x: number; y: number } = { x: best.at.x + dx, y: best.at.y + dy };
      const sc = score(c);
      if (sc.cost < best.cost) best = { at: c, cost: sc.cost };
    }
  }
  const final = pickNodes(demand, best.at, taken, u);
  return {
    location: { x: Math.round(best.at.x), y: Math.round(best.at.y) },
    nodes: final.picked.map((n) => n.id),
    avgDistance: final.avgDistance,
    short: final.short,
  };
}

/** Other factories whose output (product or surplus) could feed this one. */
export function helpfulFactories(f: Factory, factories: Factory[], plans: Record<string, Plan>, neededItems: Set<string>) {
  const out: { factory: Factory; item: string; rate: number; distance: number | null }[] = [];
  for (const o of factories) {
    if (o.id === f.id) continue;
    const p = plans[o.id];
    if (!p) continue;
    const offered: [string, number][] = [];
    if (p.rate > 0) offered.push([o.target, p.rate]);
    offered.push(...p.surplus);
    for (const [item, rate] of offered) {
      if (!neededItems.has(item)) continue;
      // Subtract what others already import from it.
      const used = factories.filter((x) => x.id !== f.id).flatMap((x) => x.imports).filter((i) => i.factoryId === o.id && i.item === item).reduce((a, b) => a + b.rate, 0);
      const free = rate - used;
      if (free > 1e-3) out.push({ factory: o, item, rate: free, distance: f.location && o.location ? dist(f.location, o.location) : null });
    }
  }
  return out.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}
