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
