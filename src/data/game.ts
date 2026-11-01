import raw from './gameData.json';
import nodesRaw from './nodes.json';

export type Form = 'solid' | 'liquid' | 'gas';
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
}
export interface Machine {
  id: string; name: string; power: number; exp: number; boostExp: number; speed: number;
  sloots: number; variable: boolean; w: number; l: number; h: number;
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

export const items = game.items;
export const recipes = game.recipes;
export const machines = game.machines;
export const extractors = game.extractors;
export const schematicsById = Object.fromEntries(game.schematics.map((s) => [s.id, s]));

export const itemName = (id: string) => items[id]?.name ?? id.replace(/^Desc_|_C$/g, '');
export const isFluid = (id: string) => items[id] != null && items[id].form !== 'solid';
export const unit = (id: string) => (isFluid(id) ? 'm³/min' : '/min');

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
  Desc_SAM_C: '#a24fd6', Desc_Geyser_C: '#e05f3f',
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
};
