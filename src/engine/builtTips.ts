import { extractors, isFluid, isPower, itemName, machines, perMinute, POWER, RAW_ITEMS, recipes, WATER } from '../data/game';
import { shortfallsOf, surplusItems } from './gameFactories';
import { buildPlan, clockPower, nodeRate, type Plan } from './plan';
import { claimedElsewhere, nearestNodes } from './placement';
import { computeUnlocks, type Progress } from './progression';
import { recipePower } from './solver';
import type { Tip } from './suggest';
import type { BuiltGroup, Factory } from './types';

/*
 * Suggestions for a factory that's already built in game. They start from what is really there — the
 * machines at their clocks and what its extractors deliver — and only suggest a change when the inputs
 * it needs are actually spare. No "more of everything" tips.
 */

const fmt = (v: number, d = 1) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return r.toLocaleString(undefined, { maximumFractionDigits: d });
};
const mw = (v: number) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000, 2)} GW` : `${fmt(v, 1)} MW`);
const rate = (item: string, v: number) => (isPower(item) ? mw(v) : `${fmt(v)}${isFluid(item) ? ' m³' : ''}/min`);
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** "Foundry" → "Foundries", "Constructor" → "Constructors" when n > 1. */
export function plural(name: string, n: number) {
  if (n === 1) return name;
  return /[^aeiou]y$/i.test(name) ? name.slice(0, -1) + 'ies' : name + 's';
}

/** Totals for one recipe's machines at the clocks set in game. */
export function groupRates(g: BuiltGroup) {
  const r = recipes[g.recipe];
  const m = machines[r?.machine];
  const speed = g.clocks.reduce((a, [c, n]) => a + (c / 100) * n, 0); // machine-equivalents at 100 %
  const power = g.clocks.reduce((a, [c, n]) => a + clockPower(recipePower(r), m?.exp ?? 1.321929, c) * n, 0);
  return {
    r, m, speed, power,
    avgClock: g.count ? (speed / g.count) * 100 : 0,
    inputs: r.in.map(([i, a]) => [i, perMinute(r, a) * speed] as [string, number]),
    outputs: r.out.map(([i, a]) => [i, perMinute(r, a) * speed] as [string, number]),
  };
}
type Row = ReturnType<typeof groupRates> & { g: BuiltGroup };

/**
 * The built factory in "max" mode, limited to what it really gets: its extractors at their in-game clocks
 * (not the node's 100% rate) plus its outside supply. Its other products stay at their current rates.
 */
export function builtMaxFactory(f: Factory): Factory {
  const g = f.game!;
  const extra = surplusItems(g);
  const also = [...(f.also ?? [])].filter((a) => !extra.has(a.item));
  for (const [item, r] of g.outputs) {
    if (item !== f.target && !extra.has(item) && !also.some((a) => a.item === item)) also.push({ item, rate: r });
  }
  // Only the recipes it already runs: "more" means re-balancing what's there, not building a new chain.
  const built = new Set(g.groups.map((x) => x.recipe));
  const excluded = Object.keys(recipes).filter((id) => !built.has(id));
  const base: Factory = { ...f, mode: 'max', rate: null, also, excluded };
  if (!g.extractors?.length) return base; // older data without extractors: fall back to the claimed nodes
  const supply: Record<string, number> = { ...f.extraSupply };
  for (const x of g.extractors) if (x.item) supply[x.item] = (supply[x.item] ?? 0) + x.rate;
  return { ...base, nodes: [], extraSupply: supply };
}

/**
 * The fair "best layout" to compare a built factory with: the same output and other products, the same
 * inputs (its extractors at their clocks and its outside supply), any recipe you have, and clocks up to
 * the highest you used in game — so overclocked builds are compared with overclocked plans.
 */
export function builtCompareFactory(f: Factory): Factory {
  const g = f.game!;
  const m = builtMaxFactory(f);
  const top = Math.max(100, ...g.groups.flatMap((x) => x.clocks.map(([c]) => c)));
  const out = g.outputs.find(([i]) => i === f.target)?.[1] ?? 0;
  return {
    ...m,
    mode: f.mode === 'max' ? 'power' : f.mode,
    rate: out,
    excluded: f.excluded,
    clockCap: Math.min(250, Math.round(top)),
    useShards: top > 100.5,
  };
}

/** What's spare right now: extractor output nobody uses, and surplus made here. */
function spareOf(f: Factory) {
  const g = f.game!;
  const need: Record<string, number> = Object.fromEntries(g.inputs);
  const spare: Record<string, number> = {};
  for (const x of g.extractors ?? []) if (x.item) spare[x.item] = (spare[x.item] ?? 0) + x.rate;
  for (const k of Object.keys(spare)) spare[k] = Math.max(0, spare[k] - (need[k] ?? 0));
  const extra = surplusItems(g);
  for (const [i, v] of g.outputs) if (extra.has(i)) spare[i] = (spare[i] ?? 0) + v;
  return spare;
}

/** Inputs `k` more machine-equivalents (at 100%) of a recipe would need that aren't spare. */
function missingFor(r: Row['r'], k: number, spare: Record<string, number>) {
  return r.in
    .map(([i, a]) => [i, perMinute(r, a) * k] as [string, number])
    .filter(([i, v]) => v > (spare[i] ?? 0) + 0.01);
}

const exClock = (clocks: [number, number][]) => {
  const n = clocks.reduce((a, [, c]) => a + c, 0);
  return n ? clocks.reduce((a, [c, k]) => a + c * k, 0) / n : 0;
};

export interface BuiltAdvice {
  tips: Tip[];
  /** Plain observations that aren't a change to make. */
  notes: string[];
}

export function builtSuggestions(
  f: Factory, maxPlan: Plan, best: Plan, progress: Progress, factories: Factory[], inGame: string[] = [],
): BuiltAdvice {
  const g = f.game!;
  const u = computeUnlocks(progress);
  const tips: Tip[] = [];
  const notes: string[] = [];
  const rows: Row[] = g.groups.filter((x) => recipes[x.recipe]).map((x) => ({ g: x, ...groupRates(x) }));
  const spare = spareOf(f);
  const extra = surplusItems(g);
  const builtOut = g.outputs.find(([i]) => i === f.target)?.[1] ?? 0;
  const need: Record<string, number> = Object.fromEntries(g.inputs);
  const exs = g.extractors ?? [];
  const recycled = rows.filter((x) => x.outputs.some(([i]) => i === WATER));

  // A step that sets a recipe to `eq` machines' worth at 100%: new clocks on what's there, or more machines.
  // Clocks only go as high as that recipe already runs in game (or 100% for new ones), so no new shards needed.
  const setTo = (id: string, eq: number) => {
    const r = recipes[id];
    const m = machines[r.machine]?.name ?? 'machine';
    const row = rows.find((x) => x.r.id === id);
    const have = row?.g.count ?? 0;
    const cap = Math.max(100, ...(row?.g.clocks.map(([c]) => c) ?? [100]));
    if (eq < 0.005) return `Remove ${the(have, r.name, m)}`;
    if (have && (eq * 100) / have <= cap + 0.01) return `Set ${the(have, r.name, m)} to ${fmt((eq * 100) / have)}%`;
    const n = Math.ceil((eq * 100) / cap - 1e-9);
    return have
      ? `Add ${n - have} ${plural(m, n - have)} on ${r.name} and set all ${n} to ${fmt((eq * 100) / n)}%`
      : `Build ${n} ${plural(m, n)} on ${r.name} at ${fmt((eq * 100) / n)}%`;
  };
  const the = (n: number, what: string, m: string) => (n === 1 ? `the ${what} ${m}` : `the ${n} ${what} ${plural(m, n)}`);
  const exName = (x: { type: string; count: number }) => plural(extractors[x.type]?.name ?? 'extractor', x.count);

  // 1. A better layout for exactly what it gets now.
  const fMax = builtMaxFactory(f);
  const possible = maxPlan.status === 'ok' ? maxPlan.rate : null;
  const better = possible !== null && possible > builtOut * 1.02 + 0.5;
  // Spare items (mined but unused, or surplus) that the better layout puts to work.
  const usedByMax = better
    ? Object.keys(spare).filter((i) => i !== WATER && spare[i] > 0.5 && (RAW_ITEMS.includes(i)
      ? (maxPlan.solve.inputs[i] ?? 0) > (need[i] ?? 0) + 0.5
      : (maxPlan.surplus.find(([s]) => s === i)?.[1] ?? 0) < spare[i] - 0.5))
    : [];
  const upTo = possible !== null ? `“Up to ${rate(f.target, possible)}”` : '';
  if (better) {
    const now: Record<string, number> = {};
    for (const x of rows) now[x.r.id] = (now[x.r.id] ?? 0) + x.speed;
    const then: Record<string, number> = {};
    for (const x of maxPlan.groups) then[x.recipe.id] = (then[x.recipe.id] ?? 0) + x.exact;
    const diff = [...new Set([...Object.keys(now), ...Object.keys(then)])]
      .map((id) => [id, (then[id] ?? 0) - (now[id] ?? 0)] as const)
      .filter(([, d]) => Math.abs(d) > 0.05)
      .sort((a, b) => b[1] - a[1]); // more first, then less
    tips.push({
      kind: 'resource', score: 80,
      title: `Up to ${rate(f.target, possible)} of ${itemName(f.target)} from the same inputs (+${fmt(((possible - builtOut) / Math.max(builtOut, 1e-9)) * 100, 0)}%)`,
      detail: usedByMax.length
        ? `It isn't using ${list(usedByMax.map((i) => `${rate(i, spare[i])} ${itemName(i)}`))}. Re-balancing the machines it has puts that to work.`
        : 'Re-balancing the machines it has gets more out of what its extractors deliver now.',
      steps: diff.map(([id]) => setTo(id, then[id] ?? 0)),
    });
  }

  // 2. What limits output: only a resource that raises output on its own counts.
  if (maxPlan.status === 'ok' && exs.length) {
    const base = maxPlan.rate;
    const capped = exs
      .filter((x) => x.item && x.item !== WATER && RAW_ITEMS.includes(x.item))
      .map((x) => x.item!)
      .filter((item, k, all) => all.indexOf(item) === k)
      // Fully used both as built now and in the best layout for what it gets.
      .filter((item) => (spare[item] ?? 0) < 0.5 && (maxPlan.supply[item] ?? 0) - (maxPlan.solve.inputs[item] ?? 0) < 0.5);
    const gainWith = (item: string, add: number) => {
      const trial = buildPlan({ ...fMax, extraSupply: { ...fMax.extraSupply, [item]: (fMax.extraSupply[item] ?? 0) + add } }, progress);
      return trial.status === 'ok' ? trial.rate - base : 0;
    };
    const limiting = capped.filter((item) => gainWith(item, Math.max((maxPlan.supply[item] ?? 0) * 0.25, 30)) > Math.max(base * 0.005, 0.05));
    const taken = claimedElsewhere(factories, f.id, inGame);
    f.nodes.forEach((n) => taken.add(n));
    for (const item of limiting.slice(0, 2)) {
      const mine = exs.filter((x) => x.item === item);
      const have = mine.reduce((a, x) => a + x.rate, 0);
      const ways: string[] = [];
      for (const x of mine) {
        const c = exClock(x.clocks);
        const top = u.overclock && progress.shards > 0 ? 250 : 100;
        if (c < top - 0.5) {
          const add = x.rate * (top / c - 1);
          const gain = gainWith(item, add);
          if (gain > 0.05) ways.push(`Set ${x.count === 1 ? 'the' : `the ${x.count}`} ${exName(x)} on ${itemName(item)} to ${top}%${top > 100 ? ' (uses power shards)' : ''}: +${rate(item, add)}, about +${rate(f.target, gain)} ${itemName(f.target)}`);
        }
      }
      if (f.location) {
        const near = nearestNodes(item, f.location, taken, 1)[0];
        const add = near ? nodeRate(near.node, u) : 0;
        const gain = add ? gainWith(item, add) : 0;
        if (near && gain > 0.05) ways.push(`Mine the nearest free ${itemName(item)} node (${near.node.purity}, ${fmt(near.d, 0)} m away): +${rate(item, add)}, about +${rate(f.target, gain)} ${itemName(f.target)}`);
      }
      if (!ways.length) continue;
      tips.push({
        kind: 'resource', score: 85,
        title: `${itemName(item)} is what limits output`,
        detail: `All ${rate(item, have)} its extractors deliver is used, and more of it alone raises output.`,
        options: ways,
        steps: ['Then add machines downstream to use it — “Plan changes” → Results shows how many'],
      });
    }
    // Fully used as built, but more of just one wouldn't help.
    const balanced = [...new Set(exs.map((x) => x.item!))]
      .filter((i) => i && i !== WATER && RAW_ITEMS.includes(i) && (spare[i] ?? 0) < 0.5 && !limiting.includes(i));
    if (!limiting.length && balanced.length > 1) {
      notes.push(`${list(balanced.map(itemName))} are all fully used and in balance — more of just one wouldn't raise output, so there's nothing to change there unless you expand the whole factory.`);
    }
  }

  // 3. Shortfalls: made here but used faster than made. Only suggest making more when its inputs are spare.
  // A machine short of two inputs is held back by the scarcer one, so that's the clock to set it to.
  const shortList = shortfallsOf(g).slice(0, 5);
  const binding: Record<string, { item: string; factor: number }> = {};
  for (const [item, short] of shortList) {
    const madeNow = rows.reduce((a, x) => a + (x.outputs.find(([i]) => i === item)?.[1] ?? 0), 0);
    const factor = madeNow / (madeNow + short);
    for (const x of rows.filter((y) => y.inputs.some(([i]) => i === item))) {
      if (!binding[x.r.id] || factor < binding[x.r.id].factor) binding[x.r.id] = { item, factor };
    }
  }
  for (const [item, short] of shortList) {
    const makers = rows.filter((x) => x.outputs.some(([i]) => i === item));
    const users = rows.filter((x) => x.inputs.some(([i]) => i === item));
    if (!makers.length || !users.length) continue;
    const m = makers[0];
    const per = perMinute(m.r, m.r.out.find(([i]) => i === item)![1]);
    const madeNow = makers.reduce((a, x) => a + (x.outputs.find(([i]) => i === item)?.[1] ?? 0), 0);
    const miss = missingFor(m.r, short / per, spare);
    const base = `Made at ${rate(item, madeNow)}, but the machines using it want ${rate(item, madeNow + short)}.`;
    if (!miss.length) {
      tips.push({
        kind: 'resource', score: 70,
        title: `${itemName(item)} is short by ${rate(item, short)}`,
        detail: `${base} The inputs to make more are spare.`,
        steps: [setTo(m.r.id, m.speed + short / per)],
      });
    } else {
      const factor = madeNow / (madeNow + short);
      tips.push({
        kind: 'clock', score: 40,
        title: `${itemName(item)} is short by ${rate(item, short)}`,
        detail: `${base} There's no spare ${list(miss.map(([i]) => itemName(i)))} to make more, so those machines already wait on it — slowing them to match saves power.`,
        steps: users.map((x) => {
          const b = binding[x.r.id];
          const who = the(x.g.count, x.r.name, x.m?.name ?? 'machine');
          return b && b.item !== item
            ? `${who[0].toUpperCase()}${who.slice(1)} ${x.g.count === 1 ? 'is' : 'are'} held back more by ${itemName(b.item)} — see that tip`
            : `Set ${who} to ${fmt(x.avgClock * factor)}%`;
        }),
      });
    }
  }

  // 4. Machines making a product below 100% — only when the inputs to speed them up are spare.
  const productMakers = rows.filter((x) => x.avgClock < 99.5 && x.outputs.some(([i]) => g.outputs.some(([o]) => o === i) && !extra.has(i)));
  const canRaise = productMakers.filter((x) => !missingFor(x.r, x.g.count - x.speed, spare).length);
  if (canRaise.length) {
    tips.push({
      kind: 'clock', score: 60,
      title: `${list(canRaise.map((x) => x.r.name))} can run at 100%`,
      detail: `The extra inputs are already spare, so this is free output: ${canRaise.map((x) => `+${rate(x.outputs[0][0], x.outputs[0][1] * (100 / x.avgClock - 1))} ${itemName(x.outputs[0][0])}`).join(', ')}.`,
      steps: canRaise.map((x) => `Set ${the(x.g.count, x.r.name, x.m?.name ?? 'machine')} to 100%`),
    });
  }

  // 5. Raw resources mined but not used: underclock the extractors.
  for (const x of exs) {
    if (!x.item || x.item === WATER || x.rate <= 0) continue;
    const used = need[x.item] ?? 0;
    const allOfItem = exs.filter((y) => y.item === x.item);
    if (allOfItem[0] !== x) continue;
    const have = allOfItem.reduce((a, y) => a + y.rate, 0);
    const left = have - used;
    if (left < 1 || used <= 0) continue;
    const c = exClock(allOfItem.flatMap((y) => y.clocks));
    const pw = allOfItem.reduce((a, y) => a + y.power, 0);
    const saved = pw - pw * Math.pow(used / have, 1.321929);
    const count = allOfItem.reduce((a, y) => a + y.count, 0);
    tips.push({
      kind: 'clock', score: 25,
      title: `${rate(x.item, left)} ${itemName(x.item)} is mined but not used`,
      detail: `Extractors deliver ${rate(x.item, have)}; the machines use ${rate(x.item, used)}.`,
      options: [
        `Set ${count === 1 ? 'the' : `the ${count}`} ${exName({ type: x.type, count })} on ${itemName(x.item)} to ${fmt((c * used) / have)}% (saves ${mw(saved)})`,
        usedByMax.includes(x.item) ? `Keep it and put it to work — see ${upTo}` : 'Keep it if you plan to grow the factory',
      ],
    });
  }

  // 6. Water: what the machines need vs. what its water extractors pump.
  const waterNeed = need[WATER] ?? 0;
  const pumps = exs.filter((x) => x.item === WATER);
  const pumpCount = pumps.reduce((a, x) => a + x.count, 0);
  const waterHave = pumps.reduce((a, x) => a + x.rate, 0);
  const loopWater = recycled.reduce((a, x) => a + (x.outputs.find(([i]) => i === WATER)?.[1] ?? 0), 0);
  const loop = recycled.length ? ` Counts the ${rate(WATER, loopWater)} from ${list(recycled.map((x) => x.r.name))} as piped back in.` : '';
  if (waterNeed > 0.01 && exs.length) {
    const pump = extractors.Build_WaterPump_C;
    if (waterHave + 0.01 < waterNeed && u.buildings.has(pump.id)) {
      const short = waterNeed - waterHave;
      const n = Math.ceil(short / pump.rate - 1e-9);
      tips.push({
        kind: 'resource', score: 90,
        title: `Water is short by ${rate(WATER, short)}`,
        detail: `Machines need ${rate(WATER, waterNeed)}; ${pumpCount ? `its water extractors pump ${rate(WATER, waterHave)}` : 'no water extractors are connected'}.${loop}`,
        options: [
          `Add ${n} Water ${plural('Extractor', n)}${n * pump.rate > short + 1e-6 ? ` at ${fmt((short / n / pump.rate) * 100)}%` : ''}`,
          ...(() => {
            if (!pumpCount) return [];
            const c = exClock(pumps.flatMap((x) => x.clocks));
            const to = (c * waterNeed) / waterHave;
            const top = u.overclock && progress.shards > 0 ? 250 : 100;
            return to <= top + 0.01 ? [`Set the ${pumpCount} Water ${plural('Extractor', pumpCount)} you have to ${fmt(to)}%${to > 100.01 ? ' (uses power shards)' : ''}`] : [];
          })(),
        ],
      });
    } else if (pumpCount > 0) {
      const each = waterHave / pumpCount;
      const sparePumps = Math.floor((waterHave - waterNeed) / each + 1e-9);
      if (sparePumps >= 1) {
        const pw = pumps.reduce((a, x) => a + x.power, 0) / pumpCount;
        const c = exClock(pumps.flatMap((x) => x.clocks));
        tips.push({
          kind: 'clock', score: 20,
          title: `${sparePumps} water ${plural('extractor', sparePumps)} more than needed`,
          detail: `They pump ${rate(WATER, waterHave)} for a need of ${rate(WATER, waterNeed)}.${loop}${recycled.length ? ` If that water isn't piped back in, the machines need ${rate(WATER, waterNeed + loopWater)} — keep them all.` : ''}`,
          options: [
            `Remove ${sparePumps} Water ${plural('Extractor', sparePumps)} (saves about ${mw(sparePumps * pw)})`,
            `Set all ${pumpCount} to ${fmt((c * waterNeed) / waterHave)}%`,
          ],
        });
      }
    }
  }

  // 7. Unlocked alternate recipes the best plan for the same output uses.
  if (best.status === 'ok' && best.rate > 0) {
    const builtRecipes = new Set(g.groups.map((x) => x.recipe));
    const missing = best.groups.filter((x) => !builtRecipes.has(x.recipe.id) && x.recipe.alt);
    if (missing.length) {
      const bestMachines = best.groups.reduce((a, x) => a + x.count, 0);
      const machinesBuilt = g.groups.reduce((a, x) => a + x.count, 0);
      tips.push({
        kind: 'recipe', score: 50,
        title: `You have ${missing.length === 1 ? 'an alternate recipe' : `${missing.length} alternate recipes`} this factory doesn’t use`,
        detail: `With ${list(missing.map((x) => x.recipe.name))}, the same output takes ${bestMachines} machines and ${mw(best.power.machines)} instead of ${machinesBuilt} and ${mw(g.power)}.`,
        steps: ['Open “Recipe by recipe vs. the best layout” below to see which machines change'],
      });
    }
  }

  // 8. Surplus: how much is over-made and how to use it or make less.
  for (const [item, left] of g.outputs.filter(([i]) => extra.has(i) && i !== f.target)) {
    const makers = rows.filter((x) => x.outputs.some(([i]) => i === item));
    const made = makers.reduce((a, x) => a + (x.outputs.find(([i]) => i === item)?.[1] ?? 0), 0);
    const used = made - left;
    const options = makers.length === 1
      ? [setTo(makers[0].r.id, makers[0].speed * (used / made))]
      : [`Slow the ${list(makers.map((x) => x.r.name))} machines to about ${fmt((used / made) * 100)}% of their current clocks`];
    const gen = Object.values(recipes).find((r) => r.generator && !r.noPlan && r.in[0]?.[0] === item && u.buildings.has(r.machine));
    if (gen) {
      const per = gen.in[0][1];
      const mwEach = gen.out.find(([i]) => i === POWER)?.[1] ?? 0;
      const n = Math.ceil(left / per - 1e-9);
      options.push(`Burn it: ${n} ${plural(machines[gen.machine]?.name ?? 'generator', n)}${n * per > left + 1e-6 ? ` at ${fmt((left / per / n) * 100)}%` : ''} make about ${mw((left / per) * mwEach)}`);
    }
    if (usedByMax.includes(item)) options.push(`Put it to work — see ${upTo}`);
    tips.push({
      kind: 'byproduct', score: 30,
      title: `${rate(item, left)} ${itemName(item)} is surplus`,
      detail: `Made at ${rate(item, made)}, used at ${rate(item, used)}. Unless the extra leaves by belt or train, it backs up and those machines idle.`,
      ...(options.length > 1 ? { options } : { steps: options }),
    });
  }

  return { tips: tips.sort((a, b) => b.score - a.score), notes };
}
