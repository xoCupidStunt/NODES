import { game, schematicsById, type Schematic } from '../data/game';

export interface Progress {
  tier: number; // highest tier the player has reached (0 = only HUB upgrades)
  milestones: string[]; // completed milestone schematic ids
  mam: string[]; // completed MAM research ids
  alts: string[]; // alternate recipe schematics unlocked from hard drives
  shards: number; // power shards available for overclocking
  sloops: number; // somersloops available
}

export const defaultProgress: Progress = { tier: 2, milestones: milestonesUpTo(2), mam: [], alts: [], shards: 0, sloops: 0 };

export const milestones = game.schematics.filter((s) => s.type === 'milestone');
export const mamResearch = game.schematics.filter((s) => s.type === 'mam' && s.tree !== 'FICSMAS');
export const altSchematics = game.schematics.filter((s) => s.type === 'alt');
export const mamTrees = [...new Set(mamResearch.map((s) => s.tree!))];

export function milestonesUpTo(tier: number) {
  return game.schematics.filter((s) => s.type === 'milestone' && s.tier <= tier).map((s) => s.id);
}

export interface Unlocks {
  recipes: Set<string>;
  buildings: Set<string>;
  overclock: boolean;
  amplify: boolean;
}

/** Everything the player can build and craft given their progress. */
export function computeUnlocks(p: Progress): Unlocks {
  const done: Schematic[] = game.schematics.filter((s) => s.type === 'tutorial' || s.type === 'custom');
  for (const id of [...p.milestones, ...p.mam, ...p.alts]) if (schematicsById[id]) done.push(schematicsById[id]);
  const recipes = new Set(game.alwaysRecipes);
  const buildings = new Set<string>();
  const flags = new Set<string>();
  for (const s of done) {
    s.recipes.forEach((r) => recipes.add(r));
    s.buildings.forEach((b) => buildings.add(b));
    s.flags?.forEach((f) => flags.add(f));
  }
  return {
    recipes,
    buildings,
    overclock: flags.has('BP_UnlockBuildOverclock_C'),
    amplify: flags.has('BP_UnlockBuildProductionBoost_C'),
  };
}

/** Which schematic unlocks a given recipe (for "unlock X to get Y" suggestions). */
export const recipeSource: Record<string, Schematic> = {};
export const buildingSource: Record<string, Schematic> = {};
for (const s of game.schematics) {
  for (const r of s.recipes) if (!recipeSource[r] || s.type !== 'custom') recipeSource[r] = s;
  for (const b of s.buildings) if (!buildingSource[b]) buildingSource[b] = s;
}

export function bestBelt(u: Unlocks) {
  return [...game.belts].reverse().find((b) => u.buildings.has(b.id)) ?? game.belts[0];
}
export function bestPipe(u: Unlocks) {
  return [...game.pipes].reverse().find((b) => u.buildings.has(b.id)) ?? game.pipes[0];
}
export function availableBelts(u: Unlocks) {
  const list = game.belts.filter((b) => u.buildings.has(b.id));
  return list.length ? list : [game.belts[0]];
}
export function availablePipes(u: Unlocks) {
  const list = game.pipes.filter((b) => u.buildings.has(b.id));
  return list.length ? list : [game.pipes[0]];
}
export function bestMiner(u: Unlocks) {
  for (const id of ['Build_MinerMk3_C', 'Build_MinerMk2_C', 'Build_MinerMk1_C']) if (u.buildings.has(id)) return game.extractors[id];
  return game.extractors.Build_MinerMk1_C;
}
