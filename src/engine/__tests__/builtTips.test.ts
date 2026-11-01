import { describe, expect, it } from 'vitest';
import { builtMaxFactory, builtSuggestions } from '../builtTips';
import { buildPlan } from '../plan';
import { milestonesUpTo, type Progress } from '../progression';
import { defaultSchematic, type Factory } from '../types';

// An aluminum factory as synced from a save: overclocked miners, water from 3 extractors plus the scrap refinery.
const progress: Progress = { tier: 8, milestones: milestonesUpTo(8), mam: [], alts: [], shards: 0, sloops: 0 };
const ex = (type: string, item: string, count: number, clock: number, rate: number) => ({ type, item, count, clocks: [[clock, count]] as [number, number][], rate, power: 50 });
const alu: Factory = {
  id: 'alu', name: 'Aluminum', target: 'Desc_AluminumPlate_C', rate: null, mode: 'power', placement: 'manual', location: null,
  nodes: [], extraSupply: {}, also: [], imports: [], excluded: [], unlimitedRaw: false, clockCap: 100, useShards: false,
  schematic: { ...defaultSchematic }, createdAt: 0,
  game: {
    machineIds: [], updatedAt: 0, power: 1000,
    groups: [
      { recipe: 'Recipe_Silica_C', count: 10, clocks: [[133.3333, 10]], boosted: 0 },
      { recipe: 'Recipe_IngotAluminum_C', count: 4, clocks: [[250, 4]], boosted: 0 },
      { recipe: 'Recipe_AluminumSheet_C', count: 4, clocks: [[250, 4]], boosted: 0 },
      { recipe: 'Recipe_AluminaSolution_C', count: 2, clocks: [[250, 2]], boosted: 0 },
      { recipe: 'Recipe_AluminumCasing_C', count: 2, clocks: [[110, 2]], boosted: 0 },
      { recipe: 'Recipe_IngotCopper_C', count: 2, clocks: [[166.6667, 2]], boosted: 0 },
      { recipe: 'Recipe_AluminumScrap_C', count: 1, clocks: [[250, 1]], boosted: 0 },
    ],
    inputs: [['Desc_OreBauxite_C', 600], ['Desc_Water_C', 600], ['Desc_Coal_C', 300], ['Desc_RawQuartz_C', 300], ['Desc_OreCopper_C', 100]],
    outputs: [['Desc_AluminumPlate_C', 300], ['Desc_AluminumCasing_C', 132], ['Desc_AluminumIngot_C', 102]],
    extractors: [
      ex('Build_WaterPump_C', 'Desc_Water_C', 3, 250, 900),
      ex('Build_MinerMk2_C', 'Desc_OreBauxite_C', 1, 250, 600),
      ex('Build_MinerMk2_C', 'Desc_Coal_C', 1, 250, 300),
      ex('Build_MinerMk2_C', 'Desc_RawQuartz_C', 1, 250, 300),
      ex('Build_MinerMk2_C', 'Desc_OreCopper_C', 1, 100, 120),
    ],
  },
};

describe('suggestions for a built factory', () => {
  it('works from what the extractors deliver and only suggests what the inputs allow', () => {
    const fMax = builtMaxFactory(alu);
    expect(fMax.extraSupply.Desc_OreBauxite_C).toBe(600);
    const maxPlan = buildPlan(fMax, progress);
    const best = buildPlan(alu, progress);
    const { tips, notes } = builtSuggestions(alu, maxPlan, best, progress, [alu]);
    const titles = tips.map((t) => t.title).join('\n');
    // No "bottleneck" for resources that are balanced, no water shortage, no extra refineries.
    expect(titles).not.toMatch(/Bauxite|Coal|Raw Quartz/);
    expect(titles).not.toMatch(/Water is short/);
    expect(tips.map((t) => t.detail).join('\n')).not.toMatch(/more Refiner/);
    // 1 of the 3 water extractors is spare (if the scrap water is piped back in).
    expect(titles).toMatch(/1 water extractor more than needed/);
    // The spare copper ore and aluminum ingot can make more sheet with the recipes it already has.
    expect(titles).toMatch(/Up to 360\/min/);
    expect(notes.join(' ')).toMatch(/Bauxite/);
  });
});
