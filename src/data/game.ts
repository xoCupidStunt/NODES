import raw from './gameData.json';
import nodesRaw from './nodes.json';

export type Form = 'solid' | 'liquid' | 'gas' | 'power';
export interface Item { id: string; name: string; form: Form; sink: number; raw: boolean }
export interface Recipe {
  id: string;
  name: string;
  alt: boolean;
  machine: string;
  time: number; // seconds per cycle
  in: [string, number][];
  out: [string, number][];
  pc?: number; // variable power constant (MW)
  pf?: number; // variable power factor (MW)
  /** A generator burning fuel (or a geyser) to make power. */
  generator?: boolean;
  /** Only for describing built factories (e.g. geothermal); never planned. */
  noPlan?: boolean;
}
export interface Machine {
  id: string; name: string; power: number; exp: number; boostExp: number; speed: number;
  sloots: number; variable: boolean; w: number; l: number; h: number;
  /** Generators: power made at 100 % clock (MW). */
  generator?: boolean; mw?: number;
}
export interface Extractor {
  id: string; name: string; kind: 'miner' | 'oil' | 'water' | 'well' | 'pressurizer';
  rate: number; power: number; w: number; l: number; h: number;
}
export interface Transport { id: string; name: string; rate: number }
export type SchematicType = 'milestone' | 'mam' | 'alt' | 'tutorial' | 'custom';
export interface Schematic {
  id: string; name: string; type: SchematicType; tier: number; recipes: string[]; buildings: string[];
  deps: string[]; tree?: string; flags?: string[];
}
export interface ResourceNode {
  id: string; item: string; purity: 'impure' | 'normal' | 'pure'; type: 'node' | 'well' | 'geyser';
  x: number; y: number; z: number;
}

interface GameData {
  version: string;
  items: Record<string, Item>;
  recipes: Record<string, Recipe>;
  machines: Record<string, Machine>;
  extractors: Record<string, Extractor>;
  belts: Transport[];
  pipes: Transport[];
  lifts: Transport[];
  schematics: Schematic[];
  alwaysRecipes: string[];
}

export const game = raw as unknown as GameData;
export const nodes = nodesRaw as ResourceNode[];

/** A resource well: one Pressurizer in the middle powers the satellite nodes around it. */
export interface ResourceWell { id: string; item: string; x: number; y: number; radius: number; satellites: ResourceNode[] }

/**
 * The node data has the satellites but not the well cores, so satellites of the same resource within
 * 100 m of each other are grouped into one well (17 in the base game: 8 water, 6 nitrogen, 3 crude oil)
 * and the core is placed at their centre.
 */
export const wells: ResourceWell[] = (() => {
  const sats = nodes.filter((n) => n.type === 'well');
  const parent = sats.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < sats.length; i++) {
    for (let j = i + 1; j < sats.length; j++) {
      if (sats[i].item === sats[j].item && Math.hypot(sats[i].x - sats[j].x, sats[i].y - sats[j].y) < 10000) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, ResourceNode[]>();
  sats.forEach((n, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), n]));
  return [...groups.values()].map((list, k) => {
    const x = list.reduce((a, n) => a + n.x, 0) / list.length;
    const y = list.reduce((a, n) => a + n.y, 0) / list.length;
    const radius = Math.max(...list.map((n) => Math.hypot(n.x - x, n.y - y)));
    return { id: `well-${k}`, item: list[0].item, x, y, radius, satellites: list };
  });
})();
/** Satellite node id → its well. */
export const wellOf: Record<string, ResourceWell> = Object.fromEntries(wells.flatMap((w) => w.satellites.map((n) => [n.id, w])));

/** "Miner node", "Resource well satellite" or "Geyser". */
export const nodeKind = (n: ResourceNode) => (n.type === 'well' ? 'Resource well satellite' : n.type === 'geyser' ? 'Geyser' : isFluid(n.item) ? 'Oil node' : 'Miner node');

export const items = game.items;
export const recipes = game.recipes;
export const machines = game.machines;
export const extractors = game.extractors;
export const schematicsById = Object.fromEntries(game.schematics.map((s) => [s.id, s]));

export const itemName = (id: string) => items[id]?.name ?? id.replace(/^Desc_|_C$/g, '');
/** Power is treated as a product (MW); it travels by power line, not belt or pipe. */
export const POWER = 'Desc_Power_C';
export const isPower = (id: string) => id === POWER;
export const isFluid = (id: string) => items[id] != null && (items[id].form === 'liquid' || items[id].form === 'gas');
export const unit = (id: string) => (isPower(id) ? 'MW' : isFluid(id) ? 'm³/min' : '/min');

export const PURITY_MULT = { impure: 0.5, normal: 1, pure: 2 } as const;
export const FOUNDATION = 8; // metres

/** Items that come out of the ground (or water / wells). */
export const RAW_ITEMS = Object.values(items).filter((i) => i.raw).map((i) => i.id);
export const WATER = 'Desc_Water_C';

/** Rate of one recipe running in one machine at 100 % clock, per minute. */
export function perMinute(r: Recipe, amount: number) {
  return (amount * 60) / r.time;
}

/** Items that can be the end product of a factory (anything produced by a machine). */
export const producibleItems = (() => {
  const set = new Set<string>();
  for (const r of Object.values(recipes)) for (const [id] of r.out) set.add(id);
  return [...set].map((id) => items[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
})();

/** World coordinate bounds used by the map (centimetres, Unreal units). */
export const WORLD = { minX: -324700, maxX: 425300, minY: -375000, maxY: 375000 };

/** Stable colour per item so belts and nodes read the same everywhere. */
const PALETTE: Record<string, string> = {
  Desc_OreIron_C: '#b0705a', Desc_OreCopper_C: '#d9844a', Desc_Stone_C: '#c9bfa5', Desc_Coal_C: '#4a4a4a',
  Desc_OreGold_C: '#e3b341', Desc_RawQuartz_C: '#e58fc5', Desc_Sulfur_C: '#d7d93e', Desc_OreBauxite_C: '#c4553f',
  Desc_OreUranium_C: '#6fd64a', Desc_LiquidOil_C: '#7a4fa3', Desc_Water_C: '#3fa0e0', Desc_NitrogenGas_C: '#8fb3c9',
  Desc_SAM_C: '#a24fd6', Desc_Geyser_C: '#e05f3f', Desc_Power_C: '#ffd23f',
};
export function itemColor(id: string): string {
  if (PALETTE[id]) return PALETTE[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 58%)`;
}

export const MACHINE_COLORS: Record<string, string> = {
  Build_SmelterMk1_C: '#d9733f', Build_ConstructorMk1_C: '#e6a23c', Build_AssemblerMk1_C: '#4f9fd9',
  Build_FoundryMk1_C: '#c4553f', Build_ManufacturerMk1_C: '#8f6bd9', Build_OilRefinery_C: '#3fae8f',
  Build_Packager_C: '#9cb35a', Build_Blender_C: '#3f8fae', Build_HadronCollider_C: '#d94f8f',
  Build_Converter_C: '#a24fd6', Build_QuantumEncoder_C: '#5a6bd9',
  Build_GeneratorBiomass_Automated_C: '#7fae3f', Build_GeneratorCoal_C: '#5c5c5c', Build_GeneratorFuel_C: '#d9a03f',
  Build_GeneratorNuclear_C: '#6fd64a', Build_GeneratorGeoThermal_C: '#e05f3f',
};
