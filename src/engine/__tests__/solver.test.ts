import { describe, expect, it } from 'vitest';
import { solvePlan } from '../solver';
import { computeUnlocks, milestonesUpTo } from '../progression';
import { recipes } from '../../data/game';

describe('solver', () => {
  it('makes reinforced iron plates from capped iron ore at tier 2', () => {
    const u = computeUnlocks({ tier: 2, milestones: milestonesUpTo(2), mam: [], alts: [], shards: 0, sloops: 0 });
    const res = solvePlan({
      target: 'Desc_IronPlateReinforced_C', rate: null, mode: 'max', recipes: u.recipes,
      supply: { Desc_OreIron_C: 120 }, unlimitedRaw: false, unlimitedWater: true,
    });
    // 120 ore -> 120 ingots. RIP: 30 plates + 60 screws per 5/min. Plates 3 ingot->2, screws via rods.
    expect(res.status).toBe('ok');
    expect(res.rate).toBeGreaterThan(5);
    console.log(res.rate, Object.entries(res.recipes).map(([k, v]) => `${recipes[k].name}: ${v.toFixed(2)}`));
  });
  it('fixed rate modes return machines', () => {
    const u = computeUnlocks({ tier: 6, milestones: milestonesUpTo(6), mam: [], alts: [], shards: 0, sloops: 0 });
    for (const mode of ['power', 'area'] as const) {
      const res = solvePlan({
        target: 'Desc_Computer_C', rate: 5, mode, recipes: u.recipes, supply: {}, unlimitedRaw: true, unlimitedWater: true,
      });
      expect(res.status).toBe('ok');
      console.log(mode, res.rate, res.power.toFixed(0), res.area.toFixed(0), Object.keys(res.inputs));
    }
  });
});
