import { solve, type Model, type Solution } from 'yalps';
import { machines, nodes, perMinute, PURITY_MULT, RAW_ITEMS, recipes, WATER, type Recipe } from '../data/game';

export type Mode = 'max' | 'power' | 'area';

export interface SolveInput {
  target: string;
  /** Wanted output per minute; null = as much as the supply allows. */
  rate: number | null;
  mode: Mode;
  recipes: Iterable<string>;
  /** Hard caps on inputs (raw resources from assigned nodes, imports from other factories), per minute. */
  supply: Record<string, number>;
  /** When true, raw resources without a cap are treated as unlimited. */
  unlimitedRaw: boolean;
  /** Water is pumped on site (unlimited) unless capped in `supply`. */
  unlimitedWater: boolean;
  /** Power per item/min for extracting each raw resource (to weigh extraction in power mode). */
  extractionPower?: Record<string, number>;
}

export interface SolveResult {
  status: 'ok' | 'infeasible' | 'no-supply';
  rate: number;
  /** Most that could be made with the capped supply (null when supply is unlimited). */
  maxRate: number | null;
  /** Machines needed per recipe at 100 % clock (fractional). */
  recipes: Record<string, number>;
  /** Inputs drawn per item, per minute. */
  inputs: Record<string, number>;
  /** Items made but not consumed (byproducts and extra), per minute. */
  surplus: Record<string, number>;
  /** Machine power + area of the solution, for comparing options. */
  power: number;
  area: number;
}

/** Scarcity weight per raw resource: rarer resources cost more. Based on world supply with Mk.3 miners. */
export const resourceWeight: Record<string, number> = (() => {
  const supply: Record<string, number> = {};
  for (const n of nodes) {
    const base = n.type === 'node' ? (n.item === 'Desc_LiquidOil_C' ? 120 : 240) : 60;
    supply[n.item] = (supply[n.item] ?? 0) + base * PURITY_MULT[n.purity];
  }
  const vals = Object.values(supply);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const w: Record<string, number> = {};
  for (const id of RAW_ITEMS) w[id] = supply[id] ? avg / supply[id] : 1;
  w[WATER] = 0.05;
  return w;
})();

export function recipePower(r: Recipe) {
  const m = machines[r.machine];
  return m.variable ? (r.pc ?? 0) + (r.pf ?? 0) / 2 : m.power;
}
export function machineArea(machineId: string) {
  const m = machines[machineId];
  return m.w * m.l;
}

const EPS = 1e-7;

function buildModel(input: SolveInput, objective: 'T' | 'cost', fixedRate: number | null, costKind: Mode) {
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {};
  const variables: Record<string, Record<string, number>> = {};
  const touched = new Set<string>();

  for (const id of input.recipes) {
    const r = recipes[id];
    if (!r) continue;
    const v: Record<string, number> = {};
    for (const [item, amt] of r.out) { v['i:' + item] = (v['i:' + item] ?? 0) + perMinute(r, amt); touched.add(item); }
    for (const [item, amt] of r.in) { v['i:' + item] = (v['i:' + item] ?? 0) - perMinute(r, amt); touched.add(item); }
    const power = recipePower(r);
    const area = machineArea(r.machine);
    v.cost = costKind === 'power' ? power : costKind === 'area' ? area : 0.001 * power;
    variables['r:' + id] = v;
  }

  for (const item of touched) {
    constraints['i:' + item] = { min: 0 };
    const cap = input.supply[item];
    const isRaw = RAW_ITEMS.includes(item);
    const unlimited = (item === WATER && input.unlimitedWater) || (isRaw && input.unlimitedRaw);
    if (cap === undefined && !unlimited) continue;
    const w = isRaw ? resourceWeight[item] ?? 1 : 0.01; // imports from other factories are nearly free
    const extraction = costKind === 'power' ? input.extractionPower?.[item] ?? 0 : 0;
    // Resources dominate in max mode (pick the least wasteful chain); they tie-break in power/area modes.
    const scale = costKind === 'max' ? 1 : 0.02;
    variables['s:' + item] = { ['i:' + item]: 1, cost: w * scale + extraction };
    if (cap !== undefined && !(unlimited && cap === Infinity)) {
      constraints['cap:' + item] = { max: cap };
      variables['s:' + item]['cap:' + item] = 1;
    }
  }

  if (fixedRate !== null) {
    constraints['i:' + input.target] = { min: fixedRate };
  } else {
    variables.T = { ['i:' + input.target]: -1, T: 1 };
  }

  const model: Model = {
    direction: objective === 'T' ? 'maximize' : 'minimize',
    objective,
    constraints,
    variables,
  };
  return model;
}

function readSolution(sol: Solution<string>, input: SolveInput, rate: number, maxRate: number | null): SolveResult {
  const rec: Record<string, number> = {};
  const inputs: Record<string, number> = {};
  for (const [k, v] of sol.variables) {
    if (v < EPS) continue;
    if (k.startsWith('r:')) rec[k.slice(2)] = v;
    else if (k.startsWith('s:')) inputs[k.slice(2)] = v;
  }
  const net: Record<string, number> = {};
  let power = 0;
  let area = 0;
  for (const [id, n] of Object.entries(rec)) {
    const r = recipes[id];
    for (const [item, amt] of r.out) net[item] = (net[item] ?? 0) + perMinute(r, amt) * n;
    for (const [item, amt] of r.in) net[item] = (net[item] ?? 0) - perMinute(r, amt) * n;
    power += recipePower(r) * n;
    area += machineArea(r.machine) * n;
  }
  for (const [item, v] of Object.entries(inputs)) net[item] = (net[item] ?? 0) + v;
  net[input.target] = (net[input.target] ?? 0) - rate;
  const surplus: Record<string, number> = {};
  for (const [item, v] of Object.entries(net)) if (v > 1e-4) surplus[item] = v;
  return { status: 'ok', rate, maxRate, recipes: rec, inputs, surplus, power, area };
}

const empty = (status: SolveResult['status'], maxRate: number | null = null): SolveResult => ({
  status, rate: 0, maxRate, recipes: {}, inputs: {}, surplus: {}, power: 0, area: 0,
});

export function solvePlan(input: SolveInput): SolveResult {
  const opts = { precision: 1e-9, maxIterations: 20000 };
  let maxRate: number | null = null;

  // Phase 1: how much can the capped supply make at most?
  const p1 = solve(buildModel(input, 'T', null, 'max'), opts);
  if (p1.status === 'optimal') maxRate = Math.max(0, p1.result);
  else if (p1.status !== 'unbounded') return empty('infeasible');

  let rate: number;
  if (input.mode === 'max' || input.rate === null) {
    if (maxRate === null) return empty('no-supply');
    rate = maxRate;
  } else {
    rate = maxRate === null ? input.rate : Math.min(input.rate, maxRate);
  }
  if (rate <= EPS) return empty(maxRate === 0 ? 'no-supply' : 'infeasible', maxRate);

  // Phase 2: hit that rate as cheaply as the chosen mode wants.
  const p2 = solve(buildModel(input, 'cost', rate * (1 - 1e-6), input.mode), opts);
  if (p2.status !== 'optimal') return empty('infeasible', maxRate);
  return readSolution(p2, input, rate, maxRate);
}
