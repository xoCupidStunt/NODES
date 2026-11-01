import { game, isFluid, itemName, items, recipes, RAW_ITEMS, WATER } from '../data/game';
import { buildPlan, clockPower, nodeRate, type Plan } from './plan';
import { claimedElsewhere, dist, helpfulFactories, nearestNodes } from './placement';
import { availableBelts, buildingSource, recipeSource, type Progress } from './progression';
import { recipePower } from './solver';
import type { Factory } from './types';

export interface Tip {
  kind: 'resource' | 'recipe' | 'clock' | 'logistics' | 'byproduct' | 'import' | 'research' | 'sloop';
  title: string;
  detail: string;
  /** Rough size of the win, used for sorting. */
  score: number;
}

const fmt = (v: number, d = 1) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(d));
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

  // 1. Bottleneck resources (max mode) and the nearest free node that would lift them.
  if (plan.maxRate !== null && f.mode === 'max') {
    const taken = claimedElsewhere(factories, f.id, inGame);
    f.nodes.forEach((n) => taken.add(n));
    for (const [item, cap] of Object.entries(plan.supply)) {
      const used = plan.solve.inputs[item] ?? 0;
      if (!RAW_ITEMS.includes(item) || used < cap - 1e-3) continue;
      let detail = `All ${fmt(cap)}/min of ${itemName(item)} is used — it limits output.`;
      if (f.location) {
        const near = nearestNodes(item, f.location, taken, 1)[0];
        if (near) detail += ` Nearest free node: ${near.node.purity} ${itemName(item)} ${fmt(near.d, 0)} m away (+${fmt(nodeRate(near.node, u))}/min).`;
      }
      tips.push({ kind: 'resource', title: `${itemName(item)} is the bottleneck`, detail, score: 90 });
    }
    // Spare resources that the plan doesn't use.
    for (const [item, cap] of Object.entries(plan.supply)) {
      const used = plan.solve.inputs[item] ?? 0;
      if (RAW_ITEMS.includes(item) && cap - used > 1 && used > 0) {
        tips.push({ kind: 'resource', title: `${fmt(cap - used)}/min ${itemName(item)} left over`, detail: `Claimed nodes give more ${itemName(item)} than this chain can use with the other limits. Add more of the bottleneck resource, or underclock the extractors to save power.`, score: 30 });
      }
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

  // 4. Somersloops.
  if (u.amplify && progress.sloops > 0) {
    const final = plan.groups.filter((g) => g.outputs.some(([i]) => i === f.target) && g.machine.sloots > 0);
    for (const g of final) {
      const need = g.machine.sloots * g.count;
      if (availableOnly && need > progress.sloops) {
        // Only as many machines as the player has somersloops for.
        const n = Math.floor(progress.sloops / g.machine.sloots);
        if (n < 1) continue;
        const extra = (plan.rate / g.count) * n;
        tips.push({ kind: 'sloop', title: `Somersloops in ${n} of the ${g.count} ${g.recipe.name} ${g.machine.name}s`, detail: `You have ${progress.sloops} somersloops — ${n * g.machine.sloots} of them (${g.machine.sloots} each) double those machines' output: about +${fmt(extra)}/min with the same inputs. Power for those machines goes ×4.`, score: 45 });
        continue;
      }
      tips.push({ kind: 'sloop', title: `Somersloops in the ${g.recipe.name} ${g.machine.name}s`, detail: `${need} somersloops (${g.machine.sloots} each) double their output to ${fmt(plan.rate * 2)}/min with the same inputs. Power for those machines goes ×4.`, score: 45 });
    }
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

