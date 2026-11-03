import { game, isFluid, itemName, items, recipes, RAW_ITEMS, WATER, type ResourceNode } from '../data/game';
import { buildPlan, clockPower, minerClockFor, nodeById, nodeRate, shardsFor, type Plan } from './plan';
import { claimedElsewhere, dist, helpfulFactories, nearestNodes } from './placement';
import { availableBelts, buildingSource, recipeSource, type Progress } from './progression';
import { recipePower } from './solver';
import type { Factory } from './types';

export interface Tip {
  kind: 'resource' | 'recipe' | 'clock' | 'logistics' | 'byproduct' | 'import' | 'research' | 'sloop';
  title: string;
  detail: string;
  /** Alternatives: do one of these. */
  options?: string[];
  /** Simple steps to make the change, in order (after the chosen option, if any). */
  steps?: string[];
  /** Rough size of the win, used for sorting. */
  score: number;
}

const fmt = (v: number, d = 1) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(d).replace(/\.0+$/, ''));
const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);

/**
 * `availableOnly`: only changes the player can make now — nothing that needs a recipe, building, research,
 * shard or somersloop they don't have.
 */
export function suggestions(f: Factory, plan: Plan, progress: Progress, factories: Factory[], plans: Record<string, Plan>, inGame: string[] = [], availableOnly = false): Tip[] {
  const tips: Tip[] = [];
  if (plan.status !== 'ok') return tips;
  const u = plan.unlocks;
  const chainItems = new Set<string>();
  for (const g of plan.groups) for (const [i] of [...g.inputs, ...g.outputs]) chainItems.add(i);

  // 1. Resources (max mode): what really limits output, and what is mined but can't be used.
  if (plan.maxRate !== null && f.mode === 'max') {
    const taken = claimedElsewhere(factories, f.id, inGame);
    f.nodes.forEach((n) => taken.add(n));
    const unitOf = (item: string) => (isFluid(item) ? ' m³/min' : '/min');
    const minerClock = minerClockFor(f, progress, u);
    const sitesOf = (item: string) => plan.extraction.filter((e) => e.item === item && e.node && e.extractor.kind !== 'pressurizer');
    const clocksOf = (item: string) => [...new Set(sitesOf(item).map((e) => `${fmt(e.clock, 1)}%`))].join(' / ');
    const raw = Object.keys(plan.supply).filter((i) => RAW_ITEMS.includes(i) && i !== WATER);
    const capped = raw.filter((i) => (plan.solve.inputs[i] ?? 0) >= plan.supply[i] - 1e-3);
    // Output with a bit more of some resources — tells which ones really limit it.
    const gainWith = (items: string[]) => {
      const extra = { ...f.extraSupply };
      for (const i of items) extra[i] = (extra[i] ?? 0) + Math.max(plan.supply[i] * 0.25, 30);
      const t = buildPlan({ ...f, extraSupply: extra }, progress);
      return t.status === 'ok' ? t.rate - plan.rate : 0;
    };
    const helps = (g: number) => g > Math.max(plan.rate * 0.005, 0.01);
    const alone = capped.filter((i) => helps(gainWith([i])));
    const together = !alone.length && capped.length > 1 && helps(gainWith(capped)) ? capped : [];

    // Ways to get more of one resource: the miners already there first, then a new node.
    const waysFor = (item: string) => {
      const unit = unitOf(item);
      const mine = f.nodes.map((id) => nodeById[id]).filter((n) => n && n.item === item);
      const sites = sitesOf(item);
      const now = Math.max(0, ...sites.map((e) => e.clock));
      const gain = mine.reduce((acc, n) => acc + nodeRate(n, u, 250) - nodeRate(n, u, Math.max(100, now)), 0);
      const minerName = sites[0]?.extractor.name ?? 'miner';
      const ways: string[] = [];
      if (mine.length && gain > 0.5) {
        const n = mine.length;
        const what = `the ${n > 1 ? `${n} ${minerName}s` : minerName} on ${itemName(item)}`;
        const shards = n * shardsFor(250);
        if (!u.overclock) {
          if (!availableOnly) ways.push(`Research “Overclock Production” in the MAM, then overclock ${what} to 250% (+${fmt(gain)}${unit}, ${shards} power shards)`);
        } else if (progress.shards <= 0) {
          ways.push(`Collect power shards, then overclock ${what} to 250% (+${fmt(gain)}${unit}, ${shards} shards)`);
        } else if (!f.useShards) {
          ways.push(`Turn on “Use power shards” in step 1 (Overclock settings) — ${what} can then run at up to 250% (+${fmt(gain)}${unit}, ${shards} of your ${progress.shards} shards)`);
        } else if (f.clockCap < 250) {
          ways.push(`Raise “Max clock” in step 1 to 250% — ${what} ${n > 1 ? 'are' : 'is'} held to ${fmt(f.clockCap, 0)}% (+${fmt(gain)}${unit})`);
        } else {
          ways.push(`Overclock ${what} further — not enough power shards for all of them at 250% (you have ${progress.shards}, the plan uses ${plan.shardsUsed})`);
        }
      }
      if (f.location) {
        const near = nearestNodes(item, f.location, taken, 1)[0];
        if (near) ways.push(`Claim the nearest free ${itemName(item)} node: ${near.node.purity}, ${fmt(near.d, 0)} m away (+${fmt(nodeRate(near.node, u))}${unit} at 100%)`);
      }
      return ways;
    };
    const spare = raw.filter((i) => plan.supply[i] - (plan.solve.inputs[i] ?? 0) > 1);
    const spareNote = spare.length ? ` ${list(spare.map(itemName))} ${spare.length > 1 ? 'are' : 'is'} left over, so ${spare.length > 1 ? 'those miners are' : 'its miners are'} already slowed to what this allows — see below.` : '';

    for (const item of alone) {
      const ways = waysFor(item);
      const clocks = clocksOf(item);
      tips.push({
        kind: 'resource', title: `${itemName(item)} limits output`, score: 90,
        detail: `All ${fmt(plan.supply[item])}${unitOf(item)} is used, and more of it alone raises output.${clocks ? ` Its miners run at ${clocks}.` : ''}${spareNote}`,
        ...(ways.length > 1 ? { options: ways } : ways.length ? { steps: ways } : {}),
      });
    }
    if (together.length) {
      tips.push({
        kind: 'resource', title: `${list(together.map(itemName))} run out together`, score: 85,
        detail: `All of each is used, and more of just one doesn't raise output — they're in balance. Growing means more of all of them.${spareNote}`,
        steps: together.map((i) => `${itemName(i)}: ${(waysFor(i)[0] ?? 'no more available nearby').replace(/^./, (c) => c.toLowerCase())}`),
      });
    }

    // Mined but not usable: the miners are already slowed to match; nodes that aren't needed can go.
    for (const item of spare) {
      const used = plan.solve.inputs[item] ?? 0;
      const fromNodes = Math.max(0, used - (f.extraSupply[item] ?? 0) - f.imports.filter((i) => i.item === item).reduce((acc, i) => acc + i.rate, 0));
      const mine = f.nodes.map((id) => nodeById[id]).filter((n) => n && n.item === item);
      const keep = fewestNodes(mine, fromNodes, (n) => nodeRate(n, u, minerClock), f.location);
      const release = mine.filter((n) => !keep.includes(n));
      const why = capped.length ? `${list(capped.map(itemName))} ${capped.length > 1 ? 'run' : 'runs'} out first` : 'the chain can’t use more';
      const clocks = clocksOf(item);
      const options: string[] = [];
      if (release.length) {
        const where = (n: ResourceNode) => `${n.purity}${f.location ? `, ${fmt(dist(n, f.location), 0)} m away` : ''}`;
        options.push(`Release ${release.length > 1 ? `${release.length} ${itemName(item)} nodes` : `the ${itemName(item)} node`} it doesn't need (${release.map(where).join('; ')}) on the Map step — ${keep.length > 1 ? 'the others still cover it' : 'the other one still covers it'}`);
      }
      if (capped.length) options.push(`Keep ${release.length ? 'them' : 'it'} for later and add ${list(capped.map(itemName))} to use it (see above)`);
      tips.push({
        kind: 'resource', title: `${fmt(plan.supply[item] - used)}${unitOf(item)} ${itemName(item)} can't be used`, score: release.length ? 60 : 30,
        detail: `The claimed nodes give ${fmt(plan.supply[item])}${unitOf(item)}, but ${why}, so this factory uses ${fmt(used)}${unitOf(item)}.${clocks ? ` Its miners are already clocked to match (${clocks}).` : ''}`,
        ...(options.length > 1 ? { options } : options.length ? { steps: options } : {}),
      });
    }
  }

  // 2. Locked alternate recipes that would help (try each relevant one).
  const lockedAlts = availableOnly ? [] : Object.values(recipes).filter((r) => r.alt && !u.recipes.has(r.id) && r.out.some(([i]) => chainItems.has(i)));
  const baseScore = objective(f, plan);
  const altTips: Tip[] = [];
  for (const r of lockedAlts.slice(0, 40)) {
    const src = recipeSource[r.id];
    if (!src) continue;
    const trial = buildPlan(f, { ...progress, alts: [...progress.alts, src.id] });
    if (trial.status !== 'ok' || !trial.groups.some((g) => g.recipe.id === r.id)) continue;
    const s = objective(f, trial);
    const gain = f.mode === 'max' ? pct(s, baseScore) : -pct(s, baseScore);
    if (gain < 2) continue;
    const what = f.mode === 'max' ? `+${fmt(gain, 0)}% output (${fmt(trial.rate)}/min)` : f.mode === 'power' ? `${fmt(gain, 0)}% less power` : `${fmt(gain, 0)}% less floor space`;
    altTips.push({
      kind: 'recipe',
      title: `Alternate recipe: ${r.name}`,
      detail: `${what}. Found on a hard drive${src.type === 'mam' ? ` (MAM: ${src.name})` : ''}.`,
      score: 40 + Math.min(gain, 50),
    });
  }
  tips.push(...altTips.sort((a, b) => b.score - a.score).slice(0, 4));

  // 3. Clock speed tips.
  const split = plan.groups.filter((g) => g.count > 1 && g.lastClock > 0 && g.lastClock < 100 && g.clock < 99.99);
  if (split.length) {
    const ex = split[0];
    tips.push({
      kind: 'clock',
      title: `${split.length} recipe${split.length > 1 ? 's' : ''} can be clocked two ways`,
      detail: `e.g. ${ex.recipe.name}: all ${ex.count} at ${fmt(ex.clock, 2)}%, or ${ex.full} at ${fmt(ex.maxClock)}% + 1 at ${fmt(ex.lastClock, 2)}%. Equal clocks use slightly less power; one odd machine is quicker to set up. Both options are in the Equipment table.`,
      score: 10,
    });
  }
  if (f.mode === 'power') {
    // Underclocking: one extra machine per group lowers total power.
    let saved = 0;
    let extra = 0;
    for (const g of plan.groups) {
      const base = recipePower(g.recipe);
      const now = clockPower(base, g.machine.exp, g.clock) * g.count;
      const n2 = g.count + 1;
      const later = clockPower(base, g.machine.exp, (g.exact / n2) * 100) * n2;
      if (now - later > 0.5) { saved += now - later; extra++; }
    }
    if (saved > 1) tips.push({ kind: 'clock', title: 'Underclock for more power savings', detail: `Adding one more machine to ${extra} groups and spreading the work saves about ${fmt(saved)} MW (power grows faster than speed).`, score: 35 });
  }
  if (!u.overclock) {
    const src = availableOnly ? undefined : game.schematics.find((s) => s.flags?.includes('BP_UnlockBuildOverclock_C'));
    if (src && plan.groups.length > 2) tips.push({ kind: 'research', title: `Research "${src.name}" in the MAM`, detail: 'Unlocks overclocking with power shards, so fewer machines can do the same work (smaller factory).', score: 20 });
  } else if (f.mode === 'area' && (!f.useShards || progress.shards === 0) && !(availableOnly && progress.shards === 0)) {
    tips.push({ kind: 'clock', title: 'Use power shards to shrink the factory', detail: 'Overclocking is unlocked. Enter your shard count in Progress and turn on "Use power shards" — each machine can run up to 250%.', score: 25 });
  }

  // 5. Logistics: next belt/pipe tier.
  const belts = availableBelts(u);
  const multi = plan.flows.filter((fl) => fl.lanes > 1);
  if (multi.length) {
    const nextBelt = game.belts.find((b) => !u.buildings.has(b.id));
    const src = nextBelt && buildingSource[nextBelt.id];
    tips.push({
      kind: 'logistics',
      title: `${multi.length} line${multi.length > 1 ? 's' : ''} need more than one ${belts.at(-1)!.name}`,
      detail: src && !availableOnly ? `Unlock "${src.name}" (tier ${src.tier}) for ${nextBelt!.name} (${nextBelt!.rate}/min), or run parallel belts as shown in the schematic.` : 'Run parallel belts or pipes for those lines (see the schematic).',
      score: 30,
    });
  }

  // 6. Byproducts.
  for (const [item, rate] of plan.surplus) {
    if (item === f.target) continue;
    const users = factories.filter((o) => o.id !== f.id && plans[o.id]?.groups.some((g) => g.inputs.some(([i]) => i === item)));
    const it = items[item];
    let detail = users.length
      ? `${users.map((o) => o.name).join(', ')} use${users.length === 1 ? 's' : ''} ${itemName(item)} — link it as an import there.`
      : isFluid(item)
        ? 'Fluids can’t be sunk directly — package it, burn it for power, or add a recipe that uses it.'
        : availableOnly && !u.buildings.has('Build_ResourceSink_C')
          ? 'Store it for later, or add a recipe you have that uses it.'
          : `Send it to an AWESOME Sink for ${fmt((it?.sink ?? 0) * rate, 0)} points/min, or store it for later.`;
    if (item === 'Desc_NuclearWaste_C') detail = 'Nuclear waste must be stored or processed further (Plutonium) — it cannot be sunk.';
    tips.push({ kind: 'byproduct', title: `Byproduct: ${fmt(rate)}${isFluid(item) ? ' m³' : ''}/min ${itemName(item)}`, detail, score: 15 });
  }

  // 7. Existing factories that could supply parts.
  const needed = new Set<string>([...chainItems].filter((i) => !(f.target === i)));
  const helpers = helpfulFactories(f, factories, plans, needed).filter((h) => !f.imports.some((i) => i.factoryId === h.factory.id && i.item === h.item));
  for (const h of helpers.slice(0, 3)) {
    tips.push({
      kind: 'import',
      title: `${h.factory.name} has ${fmt(h.rate)}/min ${itemName(h.item)} to spare`,
      detail: `${h.distance !== null ? `${fmt(h.distance, 0)} m away. ` : ''}Add it under Supply → Imports to skip making it here.`,
      score: 50,
    });
  }

  // 8. Next milestone that unlocks a better machine/extractor.
  const nextMiner = availableOnly ? undefined : ['Build_MinerMk2_C', 'Build_MinerMk3_C'].find((id) => !u.buildings.has(id));
  if (nextMiner && Object.keys(plan.solve.inputs).some((i) => RAW_ITEMS.includes(i) && i !== WATER && !isFluid(i))) {
    const src = buildingSource[nextMiner];
    if (src) tips.push({ kind: 'research', title: `${game.extractors[nextMiner].name} doubles node output`, detail: `Unlocked by "${src.name}"${src.type === 'milestone' ? ` (tier ${src.tier})` : ''}.`, score: 20 });
  }

  if (f.location && !availableOnly) {
    const far = plan.extraction.filter((e) => e.node && dist(e.node, f.location!) > 800);
    if (far.length) tips.push({ kind: 'logistics', title: `${far.length} claimed node${far.length > 1 ? 's are' : ' is'} over 800 m away`, detail: 'Consider a train or truck route, or move the factory closer with "Suggest placement".', score: 20 });
  }

  return tips.sort((a, b) => b.score - a.score);
}

function objective(f: Factory, p: Plan) {
  return f.mode === 'max' ? p.rate : f.mode === 'power' ? p.power.total : p.machineArea;
}


const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The fewest of these nodes that still give `need`, nearest first among equals; all of them if none do. */
function fewestNodes(ns: ResourceNode[], need: number, rate: (n: ResourceNode) => number, at: { x: number; y: number } | null) {
  if (need <= 1e-6) return [];
  const pool = ns.slice(0, 12);
  let best: ResourceNode[] | null = null;
  let bestKey = [Infinity, Infinity];
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    const set = pool.filter((_, k) => mask & (1 << k));
    if (set.reduce((a, n) => a + rate(n), 0) < need - 1e-6) continue;
    const key = [set.length, at ? set.reduce((a, n) => a + dist(n, at), 0) : 0];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = set; bestKey = key; }
  }
  return best ?? ns;
}
