import {
  extractors, isFluid, itemName, machines, nodes, perMinute, PURITY_MULT, recipes, WATER,
  type Extractor, type Machine, type Recipe, type ResourceNode, type Transport, isPower, POWER } from '../data/game';
import { availableBelts, availablePipes, bestMiner, computeUnlocks, type Progress, type Unlocks } from './progression';
import { recipePower, solvePlan, type SolveResult } from './solver';
import type { Factory } from './types';

export const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

export interface MachineGroup {
  id: string;
  recipe: Recipe;
  machine: Machine;
  /** Machines needed at 100 % clock (fractional). */
  exact: number;
  count: number;
  /** Clock for every machine when all run at the same speed (%). */
  clock: number;
  /** Alternative setting: `full` machines at the max clock and one at `lastClock`. */
  full: number;
  lastClock: number;
  maxClock: number;
  shardsPerMachine: number;
  /** Total MW with all machines at `clock`. */
  power: number;
  inputs: [string, number][];
  outputs: [string, number][];
  depth: number;
}

export interface Flow {
  from: string; // group id, or 'in:<item>'
  to: string; // group id, 'out', or 'surplus'
  item: string;
  rate: number;
  transport: Transport;
  lanes: number;
}

export interface ExtractionSite {
  item: string;
  node: ResourceNode | null;
  extractor: Extractor;
  count: number;
  clock: number;
  rate: number;
  power: number;
}

export interface InputLine {
  item: string;
  rate: number;
  source: 'nodes' | 'water' | 'import' | 'manual' | 'unlimited';
  note?: string;
}

/** Power travels on power lines: no belt/pipe tier or lane limit. */
const POWER_LINE = { id: 'power-line', name: 'Power line', rate: Infinity };

export interface Plan {
  status: SolveResult['status'];
  rate: number;
  maxRate: number | null;
  solve: SolveResult;
  groups: MachineGroup[];
  flows: Flow[];
  inputs: InputLine[];
  extraction: ExtractionSite[];
  surplus: [string, number][];
  /** Other products made alongside the target. */
  also: [string, number][];
  /** MW used by machines and extractors, and MW made by generators in this plan. */
  power: { machines: number; extraction: number; total: number; generated: number; net: number };
  machineArea: number;
  shardsUsed: number;
  unlocks: Unlocks;
  supply: Record<string, number>;
  warnings: string[];
}

/** Extractor that fits a node with the player's unlocks. */
export function extractorFor(node: ResourceNode, u: Unlocks): Extractor | null {
  if (node.type === 'geyser') return null;
  if (node.type === 'well') return u.buildings.has('Build_FrackingExtractor_C') ? extractors.Build_FrackingExtractor_C : null;
  if (node.item === 'Desc_LiquidOil_C') return u.buildings.has('Build_OilPump_C') ? extractors.Build_OilPump_C : null;
  return bestMiner(u);
}

/** Output per minute of a node at 100 % clock with the best unlocked extractor. */
export function nodeRate(node: ResourceNode, u: Unlocks): number {
  const ex = extractorFor(node, u);
  if (!ex) return 0;
  const rate = ex.rate * PURITY_MULT[node.purity];
  // A single belt/pipe out of the extractor caps it.
  const cap = isFluid(node.item) ? availablePipes(u).at(-1)!.rate : availableBelts(u).at(-1)!.rate;
  return Math.min(rate, cap);
}

export function shardsFor(clock: number) {
  return clock <= 100 + 1e-9 ? 0 : Math.ceil((clock - 100 - 1e-9) / 50);
}

export function clockPower(base: number, exp: number, clock: number) {
  return base * Math.pow(clock / 100, exp);
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Supply caps for a factory: claimed nodes, manual extras and imports. */
export function supplyFor(f: Factory, u: Unlocks): Record<string, number> {
  const s: Record<string, number> = {};
  for (const id of f.nodes) {
    const n = nodeById[id];
    if (n) s[n.item] = (s[n.item] ?? 0) + nodeRate(n, u);
  }
  for (const [item, v] of Object.entries(f.extraSupply)) if (v > 0) s[item] = (s[item] ?? 0) + v;
  for (const imp of f.imports) if (imp.rate > 0) s[imp.item] = (s[imp.item] ?? 0) + imp.rate;
  return s;
}

export function allowedRecipes(f: Factory, u: Unlocks) {
  const ex = new Set(f.excluded);
  return [...u.recipes].filter((id) => recipes[id] && !recipes[id].noPlan && !ex.has(id) && u.buildings.has(recipes[id].machine));
}

export function buildPlan(f: Factory, progress: Progress): Plan {
  const u = computeUnlocks(progress);
  const supply = supplyFor(f, u);
  const extractionPower: Record<string, number> = {};
  const miner = bestMiner(u);
  for (const item of Object.keys(supply)) extractionPower[item] = miner.power / miner.rate;
  extractionPower[WATER] = extractors.Build_WaterPump_C.power / extractors.Build_WaterPump_C.rate;

  const solve = solvePlan({
    target: f.target,
    rate: f.rate,
    also: Object.fromEntries((f.also ?? []).filter((a) => a.item !== f.target && a.rate > 0).map((a) => [a.item, a.rate])),
    mode: f.mode,
    recipes: allowedRecipes(f, u),
    supply,
    unlimitedRaw: f.unlimitedRaw,
    unlimitedWater: !(WATER in supply) || f.unlimitedRaw,
    extractionPower,
  });

  const warnings: string[] = [];

  // ---- machines & clocks ----
  const overclockOk = u.overclock && f.useShards && progress.shards > 0;
  let shardsLeft = overclockOk ? progress.shards : 0;
  const cap = overclockOk ? Math.min(250, Math.max(1, f.clockCap)) : Math.min(100, Math.max(1, f.clockCap));
  // Hand shards to the groups that save the most machines first.
  const order = Object.entries(solve.recipes).sort((a, b) => b[1] * machines[recipes[b[0]].machine].w - a[1] * machines[recipes[a[0]].machine].w);
  const groups: MachineGroup[] = [];
  for (const [rid, exact] of order) {
    if (exact < 1e-3) continue; // solver rounding noise, not a real machine
    const r = recipes[rid];
    const m = machines[r.machine];
    let maxClock = Math.min(cap, 100);
    if (cap > 100) {
      // Find the highest clock we can afford shards for.
      for (let c = cap; c > 100; c -= 50) {
        const cnt = Math.ceil(exact / (c / 100) - 1e-9);
        const need = cnt * shardsFor(Math.min(c, (exact / cnt) * 100));
        if (need <= shardsLeft) { maxClock = c; break; }
      }
    }
    const count = Math.max(1, Math.ceil(exact / (maxClock / 100) - 1e-9));
    const clock = round((exact / count) * 100);
    const full = Math.floor(exact / (maxClock / 100) + 1e-9);
    const lastClock = round((exact - full * (maxClock / 100)) * 100);
    const shardsPerMachine = shardsFor(clock);
    shardsLeft -= shardsPerMachine * count;
    const base = recipePower(r);
    groups.push({
      id: rid, recipe: r, machine: m, exact, count, clock, full, lastClock: lastClock < 1e-3 ? 0 : lastClock,
      maxClock, shardsPerMachine,
      power: clockPower(base, m.exp, clock) * count,
      inputs: r.in.map(([i, a]) => [i, perMinute(r, a) * exact]),
      outputs: r.out.map(([i, a]) => [i, perMinute(r, a) * exact]),
      depth: 0,
    });
  }
  const shardsUsed = overclockOk ? progress.shards - shardsLeft : 0;

  // ---- depth (raw → product) for layout ----
  const producers: Record<string, MachineGroup[]> = {};
  for (const g of groups) for (const [item] of g.outputs) (producers[item] ??= []).push(g);
  for (let pass = 0; pass < groups.length + 1; pass++) {
    let changed = false;
    for (const g of groups) {
      let d = 0;
      for (const [item] of g.inputs) for (const p of producers[item] ?? []) if (p !== g) d = Math.max(d, p.depth + 1);
      if (d !== g.depth && d <= groups.length) { g.depth = d; changed = true; }
    }
    if (!changed) break;
  }
  groups.sort((a, b) => a.depth - b.depth || a.recipe.name.localeCompare(b.recipe.name));

  // ---- flows: share every item proportionally between makers and users ----
  const belts = availableBelts(u);
  const pipes = availablePipes(u);
  const transportFor = (item: string, rate: number) => {
    if (isPower(item)) return { transport: POWER_LINE, lanes: 1 };
    const list = isFluid(item) ? pipes : belts;
    const t = list.find((b) => b.rate >= rate - 1e-6) ?? list[list.length - 1];
    return { transport: t, lanes: Math.max(1, Math.ceil(rate / t.rate - 1e-6)) };
  };
  const makers: Record<string, [string, number][]> = {};
  const users: Record<string, [string, number][]> = {};
  for (const g of groups) {
    for (const [i, v] of g.outputs) (makers[i] ??= []).push([g.id, v]);
    for (const [i, v] of g.inputs) (users[i] ??= []).push([g.id, v]);
  }
  for (const [i, v] of Object.entries(solve.inputs)) (makers[i] ??= []).push(['in:' + i, v]);
  if (solve.rate > 0) (users[f.target] ??= []).push(['out', solve.rate]);
  for (const a of f.also ?? []) if (solve.status === 'ok' && a.item !== f.target && a.rate > 0) (users[a.item] ??= []).push(['out', a.rate]);
  for (const [i, v] of Object.entries(solve.surplus)) (users[i] ??= []).push(['surplus', v]);
  const flows: Flow[] = [];
  for (const item of Object.keys(makers)) {
    const from = makers[item];
    const to = users[item] ?? [];
    const totalFrom = from.reduce((a, b) => a + b[1], 0);
    for (const [fid, fv] of from) {
      for (const [tid, tv] of to) {
        if (fid === tid) continue;
        const rate = (fv * tv) / totalFrom;
        if (rate < 1e-4) continue;
        flows.push({ from: fid, to: tid, item, rate, ...transportFor(item, rate) });
      }
    }
  }
  for (const fl of flows) {
    if (fl.lanes > 1) {
      warnings.push(`${fl.rate.toFixed(1)}/min of ${itemName(fl.item)} needs ${fl.lanes}× ${fl.transport.name} — split the line or unlock faster ${isFluid(fl.item) ? 'pipes' : 'belts'}.`);
    }
  }

  // ---- inputs & extraction ----
  const inputs: InputLine[] = [];
  const extraction: ExtractionSite[] = [];
  for (const [item, rate] of Object.entries(solve.inputs).sort((a, b) => b[1] - a[1])) {
    let left = rate;
    const imp = f.imports.filter((x) => x.item === item).reduce((a, b) => a + b.rate, 0);
    if (imp > 0) {
      const use = Math.min(left, imp);
      inputs.push({ item, rate: use, source: 'import' });
      left -= use;
    }
    const claimed = f.nodes.map((id) => nodeById[id]).filter((n) => n && n.item === item)
      .sort((a, b) => PURITY_MULT[b.purity] - PURITY_MULT[a.purity]);
    let fromNodes = 0;
    for (const n of claimed) {
      if (left <= 1e-6) break;
      const ex = extractorFor(n, u);
      const capRate = nodeRate(n, u);
      if (!ex || capRate <= 0) continue;
      const use = Math.min(left, capRate);
      const clock = round((use / (ex.rate * PURITY_MULT[n.purity])) * 100, 2);
      extraction.push({ item, node: n, extractor: ex, count: 1, clock, rate: use, power: clockPower(ex.power, 1.321929, clock) });
      fromNodes += use;
      left -= use;
    }
    if (fromNodes > 0) inputs.push({ item, rate: fromNodes, source: 'nodes' });
    if (left > 1e-6 && item === WATER) {
      const wp = extractors.Build_WaterPump_C;
      const count = Math.ceil(left / wp.rate - 1e-9);
      const clock = round((left / count / wp.rate) * 100, 2);
      extraction.push({ item, node: null, extractor: wp, count, clock, rate: left, power: clockPower(wp.power, 1.321929, clock) * count });
      inputs.push({ item, rate: left, source: 'water' });
      left = 0;
    }
    const manual = f.extraSupply[item] ?? 0;
    if (left > 1e-6 && manual > 0) {
      const use = Math.min(left, manual);
      inputs.push({ item, rate: use, source: 'manual' });
      left -= use;
    }
    if (left > 1e-6) inputs.push({ item, rate: left, source: 'unlimited', note: 'no node claimed yet' });
  }
  // Each resource well cluster needs one pressurizer.
  const wellSites = extraction.filter((e) => e.node?.type === 'well');
  const clusters: ResourceNode[] = [];
  for (const w of wellSites) if (!clusters.some((c) => Math.hypot(c.x - w.node!.x, c.y - w.node!.y) < 20000)) clusters.push(w.node!);
  for (const c of clusters) {
    const p = extractors.Build_FrackingSmasher_C;
    extraction.push({ item: c.item, node: c, extractor: p, count: 1, clock: 100, rate: 0, power: p.power });
  }

  const machinePower = groups.reduce((a, g) => a + g.power, 0);
  const generated = groups.reduce((a, g) => a + g.outputs.filter(([i]) => i === POWER).reduce((s, [, v]) => s + v, 0), 0);
  const extractionPower2 = extraction.reduce((a, e) => a + e.power, 0);

  if (solve.status === 'no-supply') {
    warnings.push(f.unlimitedRaw
      ? 'Set a target rate — with unlimited resources there is no maximum.'
      : 'No resources yet: claim nodes on the Map tab, add supply manually, or switch on "unlimited resources".');
  }
  if (solve.status === 'infeasible') warnings.push((f.also ?? []).length ? 'This product mix cannot be made with your unlocked recipes and the resources available — try lower rates for the extra products.' : 'This product cannot be made with your unlocked recipes and the resources available.');

  return {
    status: solve.status,
    rate: solve.rate,
    maxRate: solve.maxRate,
    solve,
    groups,
    flows,
    inputs,
    extraction,
    surplus: Object.entries(solve.surplus).sort((a, b) => b[1] - a[1]),
    also: solve.status === 'ok' ? (f.also ?? []).filter((a) => a.item !== f.target && a.rate > 0).map((a) => [a.item, a.rate] as [string, number]) : [],
    power: { machines: machinePower, extraction: extractionPower2, total: machinePower + extractionPower2, generated, net: generated - machinePower - extractionPower2 },
    machineArea: groups.reduce((a, g) => a + g.machine.w * g.machine.l * g.count, 0),
    shardsUsed,
    unlocks: u,
    supply,
    warnings,
  };
}
