import { describe, expect, it } from 'vitest';
import { buildPlan } from '../plan';
import { suggestLocation } from '../placement';
import { buildSchematic } from '../schematic';
import { milestonesUpTo, type Progress } from '../progression';
import { suggestions } from '../suggest';
import { defaultSchematic, type Factory } from '../types';

const progress = (tier: number): Progress => ({ tier, milestones: milestonesUpTo(tier), mam: [], alts: [], shards: 0, sloops: 0 });
const factory = (patch: Partial<Factory>): Factory => ({
  id: 'a', name: 'Test', target: 'Desc_IronPlateReinforced_C', rate: 10, mode: 'power', placement: 'manual', location: null,
  nodes: [], extraSupply: {}, imports: [], excluded: [], unlimitedRaw: true, clockCap: 100, useShards: false,
  schematic: { ...defaultSchematic }, createdAt: 0, ...patch,
});

describe('plan', () => {
  it('rounds machines up and sets clocks', () => {
    const p = buildPlan(factory({ rate: 5 }), progress(2));
    expect(p.status).toBe('ok');
    const rip = p.groups.find((g) => g.recipe.name === 'Reinforced Iron Plate')!;
    expect(rip.count).toBe(1);
    expect(rip.clock).toBeCloseTo(100);
    const screws = p.groups.find((g) => g.recipe.name === 'Screws')!;
    expect(screws.count).toBe(2); // 60 screws/min at 40/min each = 1.5
    expect(screws.clock).toBeCloseTo(75);
    expect(p.power.total).toBeGreaterThan(0);
  });

  it('suggests a location and claims iron nodes, then maxes output', () => {
    const f = factory({ unlimitedRaw: false, mode: 'max' });
    const s = suggestLocation(f, [f], progress(2))!;
    expect(s).not.toBeNull();
    expect(s.short).toBe(0);
    const p = buildPlan({ ...f, location: s.location, nodes: s.nodes }, progress(2));
    expect(p.status).toBe('ok');
    expect(p.rate).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(p.extraction.length).toBeGreaterThan(0);
    const tips = suggestions({ ...f, location: s.location, nodes: s.nodes }, p, progress(2), [f], { a: p });
    expect(tips.length).toBeGreaterThan(0);
  });

  it('builds a schematic on multiple floors with fluids', () => {
    const f = factory({ target: 'Desc_Plastic_C', rate: 60 });
    const p = buildPlan(f, progress(5));
    expect(p.status).toBe('ok');
    for (const logistics of ['visible', 'underfloor', 'walls'] as const) {
      const sch = buildSchematic(p, { ...defaultSchematic, floors: 2, logistics }, f.target);
      expect(sch.floors.length).toBeGreaterThanOrEqual(1);
      expect(sch.width % 8).toBe(0);
      expect(sch.height % 8).toBe(0);
      for (const fl of sch.floors) for (const m of fl.machines) {
        expect(m.x).toBeGreaterThanOrEqual(0);
        expect(m.x + m.w).toBeLessThanOrEqual(sch.width);
        expect(m.y + m.l).toBeLessThanOrEqual(sch.height);
      }
    }
  });

  it('computer plan at tier 8 with somersloops/shards does not crash', () => {
    const pr = { ...progress(8), shards: 30, sloops: 10 };
    const p = buildPlan(factory({ target: 'Desc_Computer_C', rate: 10, mode: 'area', useShards: true, clockCap: 250 }), pr);
    expect(p.status).toBe('ok');
    const sch = buildSchematic(p, defaultSchematic, 'Desc_Computer_C');
    expect(sch.bom.length).toBeGreaterThan(3);
  });
});
