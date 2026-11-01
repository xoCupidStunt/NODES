import { isFluid, itemName, RAW_ITEMS, WATER } from '../data/game';
import { surplusItems, type FoundFactory } from './gameFactories';
import { buildPlan, nodeRate, type Plan } from './plan';
import { claimedElsewhere, dist, nearestNodes } from './placement';
import type { Progress } from './progression';
import type { Factory } from './types';

/*
 * Logistics check for a factory being planned: supply that has to travel far, and parts no other
 * factory makes, so the whole chain would have to be built (and belted) here.
 */

export const FAR_METRES = 1000;

export interface LogisticsWarning {
  kind: 'distance' | 'split';
  title: string;
  detail: string;
  options?: string[];
  /** Parts that could get their own factory, with the rate this one needs. */
  parts?: { item: string; rate: number; machines: number; makers: { name: string; distance: number | null }[] }[];
}

const fmt = (v: number, d = 1) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return r.toLocaleString(undefined, { maximumFractionDigits: d });
};
const rate = (item: string, v: number) => `${fmt(v)}${isFluid(item) ? ' m³' : ''}/min`;
const km = (m: number) => (m >= 2000 ? `${fmt(m / 1000, 1)} km` : `${fmt(m, 0)} m`);

interface Producer { name: string; location: { x: number; y: number } | null; items: Set<string> }

/** Every other factory (planned or found in the game) and what it makes. */
function producers(f: Factory, factories: Factory[], plans: Record<string, Plan>, foundNotAdded: FoundFactory[]): Producer[] {
  const out: Producer[] = [];
  for (const o of factories) {
    if (o.id === f.id) continue;
    const items = new Set<string>();
    if (o.game) {
      const extra = surplusItems(o.game);
      for (const [i] of o.game.outputs) if (!extra.has(i)) items.add(i);
    } else {
      const p = plans[o.id];
      if (p?.status === 'ok' && p.rate > 0) items.add(o.target);
      for (const a of o.also ?? []) items.add(a.item);
    }
    out.push({ name: o.name, location: o.location, items });
  }
  for (const ff of foundNotAdded) {
    const extra = surplusItems(ff.built);
    out.push({ name: `${ff.name} (in game, not added)`, location: ff.location, items: new Set(ff.built.outputs.map(([i]) => i).filter((i) => !extra.has(i))) });
  }
  return out;
}

export function logisticsCheck(
  f: Factory, plan: Plan, progress: Progress, factories: Factory[], plans: Record<string, Plan>,
  foundNotAdded: FoundFactory[] = [], inGame: string[] = [],
): LogisticsWarning[] {
  const out: LogisticsWarning[] = [];
  if (plan.status !== 'ok' || f.game) return out;
  const u = plan.unlocks;

  // 1. Raw resources from nodes over 1 km away: process them where they're mined.
  if (f.location) {
    const at = f.location;
    const far = new Map<string, { count: number; rate: number; max: number }>();
    for (const e of plan.extraction) {
      if (!e.node || e.item === WATER || e.rate <= 0) continue;
      const d = dist(e.node, at);
      if (d <= FAR_METRES) continue;
      const cur = far.get(e.item) ?? { count: 0, rate: 0, max: 0 };
      cur.count += 1; cur.rate += e.rate; cur.max = Math.max(cur.max, d);
      far.set(e.item, cur);
    }
    const taken = claimedElsewhere(factories, f.id, inGame);
    for (const [item, x] of far) {
      // The first thing made from it here — what to make next to the nodes instead.
      const first = plan.groups.find((g) => g.inputs.some(([i]) => i === item));
      const product = first?.outputs.find(([i]) => !RAW_ITEMS.includes(i))?.[0];
      const options: string[] = [];
      if (product) options.push(`Build a small ${itemName(product)} factory by the nodes and ship ${itemName(product)} here instead of raw ${itemName(item)}`);
      const closer = nearestNodes(item, at, taken, 12).filter((n) => n.d <= FAR_METRES && !f.nodes.includes(n.node.id) && nodeRate(n.node, u) > 0);
      if (closer.length) options.push(`Claim closer ${itemName(item)} nodes on the Map step — ${closer.length} free within 1 km (nearest ${km(closer[0].d)})`);
      options.push(`Plan a train or truck route for ${rate(item, x.rate)} ${itemName(item)}`);
      out.push({
        kind: 'distance',
        title: x.count > 1 ? `${itemName(item)} comes from ${x.count} nodes over 1 km away (up to ${km(x.max)})` : `${itemName(item)} comes from a node ${km(x.max)} away`,
        detail: `That's ${rate(item, x.rate)} of raw ${itemName(item)} on long belts${isFluid(item) ? ' or pipes' : ''}. Processing it near the nodes, or bringing it in by train, is easier to build and keep running.`,
        options,
      });
    }

    // Imports from factories over 1 km away.
    for (const imp of f.imports) {
      const src = factories.find((o) => o.id === imp.factoryId);
      if (!src?.location) continue;
      const d = dist(src.location, at);
      if (d <= FAR_METRES) continue;
      out.push({
        kind: 'distance',
        title: `${itemName(imp.item)} from ${src.name} travels ${km(d)}`,
        detail: `Importing ${rate(imp.item, imp.rate)} over that distance needs a long belt, a train or trucks.`,
        options: [
          `Plan a train or truck route between ${src.name} and this factory`,
          'Move this factory closer — use “Suggest placement” on the Map step, which counts imports',
          `Make the ${itemName(imp.item)} here instead (remove the import on the Map step)`,
        ],
      });
    }
  }

  // 2. Parts made in this factory that no other factory makes: the bigger ones could get their own factory.
  const total = plan.groups.reduce((a, g) => a + g.count, 0);
  const finals = new Set([f.target, ...(f.also ?? []).map((a) => a.item)]);
  const madeHere = new Set(plan.groups.flatMap((g) => g.outputs.map(([i]) => i)));
  // Parts that go straight into the final products.
  const partNeed = new Map<string, number>();
  for (const g of plan.groups) {
    if (!g.outputs.some(([i]) => finals.has(i))) continue;
    for (const [i, v] of g.inputs) {
      if (RAW_ITEMS.includes(i) || i === WATER || finals.has(i) || !madeHere.has(i)) continue;
      partNeed.set(i, (partNeed.get(i) ?? 0) + v);
    }
  }
  if (total >= 12 && partNeed.size) {
    const others = producers(f, factories, plans, foundNotAdded);
    const parts: NonNullable<LogisticsWarning['parts']> = [];
    for (const [item, need] of partNeed) {
      // How big the chain for that part alone is.
      const sub = buildPlan({ ...f, id: `${f.id}-part`, target: item, rate: need, also: [], mode: 'power', imports: [], nodes: [], extraSupply: {}, unlimitedRaw: true }, progress);
      const machines = sub.status === 'ok' ? sub.groups.reduce((a, g) => a + g.count, 0) : 0;
      const makers = others
        .filter((p) => p.items.has(item))
        .map((p) => ({ name: p.name, distance: p.location && f.location ? dist(p.location, f.location) : null }))
        .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
      if (machines >= 4 || makers.length) parts.push({ item, rate: need, machines, makers });
    }
    parts.sort((a, b) => b.machines - a.machines);
    const missing = parts.filter((p) => !p.makers.length);
    if (parts.length) {
      out.push({
        kind: 'split',
        title: missing.length
          ? `${missing.length === 1 ? `${itemName(missing[0].item)} isn't` : `${missing.length} of its parts aren't`} made by any other factory`
          : 'Some of its parts are already made elsewhere',
        detail: `As planned, this is a ${total}-machine build with the whole chain inside. Making the bigger parts in their own factories keeps each build smaller and the belts simpler.`,
        parts,
      });
    }
  }
  return out;
}
