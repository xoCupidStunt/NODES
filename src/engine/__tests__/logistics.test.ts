import { describe, expect, it } from 'vitest';
import { nodes } from '../../data/game';
import { logisticsCheck } from '../logistics';
import { buildPlan } from '../plan';
import { dist } from '../placement';
import { milestonesUpTo, type Progress } from '../progression';
import { defaultSchematic, type Factory } from '../types';

const progress: Progress = { tier: 4, milestones: milestonesUpTo(4), mam: [], alts: [], shards: 0, sloops: 0 };
const base = (patch: Partial<Factory>): Factory => ({
  id: 'm', name: 'Motors', target: 'Desc_Motor_C', rate: 5, mode: 'power', placement: 'manual', location: null,
  nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: true, clockCap: 100, useShards: false,
  schematic: { ...defaultSchematic }, createdAt: 0, ...patch,
});

describe('logistics check for a new factory', () => {
  it('suggests separate factories for big parts nobody makes', () => {
    const f = base({});
    const w = logisticsCheck(f, buildPlan(f, progress), progress, [f], {});
    const split = w.find((x) => x.kind === 'split')!;
    expect(split).toBeTruthy();
    expect(split.parts!.map((p) => p.item)).toEqual(expect.arrayContaining(['Desc_Rotor_C', 'Desc_Stator_C']));
    expect(split.parts!.every((p) => p.makers.length === 0)).toBe(true);
  });

  it('names the factory that already makes a part', () => {
    const f = base({});
    const rotors = base({ id: 'r', name: 'Rotor works', target: 'Desc_Rotor_C', rate: 20 });
    const factories = [f, rotors];
    const plans = { m: buildPlan(f, progress), r: buildPlan(rotors, progress) };
    const split = logisticsCheck(f, plans.m, progress, factories, plans).find((x) => x.kind === 'split')!;
    expect(split.parts!.find((p) => p.item === 'Desc_Rotor_C')!.makers[0].name).toBe('Rotor works');
  });

  it('warns about nodes over 1 km away', () => {
    const iron = nodes.find((n) => n.item === 'Desc_OreIron_C' && n.type !== 'geyser')!;
    const at = { x: iron.x + 150000, y: iron.y }; // 1.5 km east
    expect(dist(iron, at)).toBeGreaterThan(1000);
    const f = base({ target: 'Desc_IronPlate_C', rate: 20, unlimitedRaw: false, location: at, nodes: [iron.id] });
    const w = logisticsCheck(f, buildPlan(f, progress), progress, [f], {});
    const far = w.find((x) => x.kind === 'distance')!;
    expect(far.title).toMatch(/Iron Ore comes from a node/);
    expect(far.options![0]).toMatch(/Iron Ingot factory by the nodes/);
  });
});

describe('node picking', () => {
  it('never claims a node the demand does not need', async () => {
    const { pickNodes } = await import('../placement');
    const { computeUnlocks } = await import('../progression');
    const { nodeRate } = await import('../plan');
    const u = computeUnlocks(progress);
    const spots = nodes.filter((n) => n.item === 'Desc_Coal_C').slice(0, 6).map((n) => ({ x: n.x + 30000, y: n.y }));
    for (const at of spots) {
      for (const need of [50, 130, 544]) {
        const { picked, short } = pickNodes({ Desc_Coal_C: need }, at, new Set(), u);
        if (short > 0) continue;
        const rates = picked.map((n) => nodeRate(n, u));
        const total = rates.reduce((a, b) => a + b, 0);
        // Dropping any one node must leave it short.
        for (const r of rates) expect(total - r).toBeLessThan(need - 1e-6);
      }
    }
  });
});
