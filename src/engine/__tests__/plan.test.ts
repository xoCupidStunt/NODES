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
  nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: true, clockCap: 100, useShards: false,
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

describe('several products', () => {
  it('makes the extra products at their rates', () => {
    const p = buildPlan(factory({ rate: 5, also: [{ item: 'Desc_IronScrew_C', rate: 30 }, { item: 'Desc_Wire_C', rate: 20 }] }), progress(2));
    expect(p.status).toBe('ok');
    expect(p.also).toEqual([['Desc_IronScrew_C', 30], ['Desc_Wire_C', 20]]);
    const made = (item: string) => p.groups.flatMap((g) => g.outputs).filter(([i]) => i === item).reduce((a, [, v]) => a + v, 0);
    const used = (item: string) => p.groups.flatMap((g) => g.inputs).filter(([i]) => i === item).reduce((a, [, v]) => a + v, 0);
    expect(made('Desc_IronScrew_C') - used('Desc_IronScrew_C')).toBeCloseTo(30, 3);
    expect(made('Desc_Wire_C') - used('Desc_Wire_C')).toBeCloseTo(20, 3);
    expect(p.surplus.find(([i]) => i === 'Desc_Wire_C')).toBeUndefined();
  });
});

describe('power as a product', () => {
  it('plans coal generators for a power target', () => {
    const p = buildPlan(factory({ target: 'Desc_Power_C', rate: 750, excluded: [] }), progress(3));
    expect(p.status).toBe('ok');
    const gen = p.groups.find((g) => g.machine.id === 'Build_GeneratorCoal_C')!;
    expect(gen.count).toBe(10);
    expect(p.power.generated).toBeCloseTo(750, 1);
    expect(p.solve.inputs['Desc_Coal_C']).toBeCloseTo(150, 1);
    expect(p.solve.inputs['Desc_Water_C']).toBeCloseTo(450, 1);
    expect(p.flows.filter((f) => f.item === 'Desc_Power_C').every((f) => f.lanes === 1)).toBe(true);
    const sch = buildSchematic(p, defaultSchematic, 'Desc_Power_C');
    expect(sch.notes.some((n) => n.includes('750 MW'))).toBe(true);
  });
});

describe('suggestions with what is available', () => {
  it('leaves out anything that needs an unlock', () => {
    const f = factory({ rate: 20 });
    const p = buildPlan(f, progress(2));
    const all = suggestions(f, p, progress(2), [f], { a: p });
    const avail = suggestions(f, p, progress(2), [f], { a: p }, [], true);
    expect(all.some((t) => t.kind === 'recipe' || t.kind === 'research')).toBe(true);
    expect(avail.some((t) => t.kind === 'recipe' || t.kind === 'research')).toBe(false);
    expect(avail.every((t) => !/Unlock|Research|Mk\.3|hard drive/i.test(t.title + t.detail))).toBe(true);
  });
});

describe('schematic orientation and extraction yard', () => {
  it('turns the input wall toward the supply and lists each source', async () => {
    const { nodes } = await import('../../data/game');
    const { facingFor } = await import('../schematic');
    const iron = nodes.find((n) => n.item === 'Desc_OreIron_C' && n.type === 'node')!;
    const f = factory({ target: 'Desc_IronPlate_C', rate: 20, unlimitedRaw: false, nodes: [iron.id], location: { x: iron.x - 40000, y: iron.y } });
    const p = buildPlan(f, progress(4));
    const ctx = { location: f.location, imports: [] };
    expect(facingFor(p, ctx).facing).toBe('E');
    const sch = buildSchematic(p, { ...defaultSchematic }, f.target, ctx);
    expect(sch.facing).toBe('E');
    const miner = sch.sources.find((s) => s.kind === 'extractor')!;
    expect(miner.title).toMatch(/Miner/);
    expect(miner.lines.join(' ')).toMatch(/400 m E/);
    expect(miner.y).toBeLessThan(0); // outside the input wall
    expect(sch.bom.some((b) => /Miner .*at the nodes/.test(b.name))).toBe(true);
    // A fixed side wins over the automatic one.
    expect(buildSchematic(p, { ...defaultSchematic, orientation: 'S' }, f.target, ctx).facing).toBe('S');
  });

  it('groups resource well satellites into 17 wells', async () => {
    const { wells } = await import('../../data/game');
    expect(wells.length).toBe(17);
    expect(wells.every((w) => w.satellites.length >= 6)).toBe(true);
  });
});
