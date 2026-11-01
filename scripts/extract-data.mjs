// Builds src/data/gameData.json from the game's own Docs file (CommunityResources/Docs/en-US.json)
// and src/data/nodes.json from the resource node dataset in scripts/source/.
//
// Usage: npm run extract -- "<path to Satisfactory install>"
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INSTALL = 'D:/SteamLibrary/steamapps/common/Satisfactory';
const install = process.argv[2] || process.env.SATISFACTORY_DIR || DEFAULT_INSTALL;
const docsPath = path.join(install, 'CommunityResources/Docs/en-US.json');

function readDocs(file) {
  const buf = fs.readFileSync(file);
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const docs = readDocs(docsPath);
const byNative = {};
const all = [];
for (const group of docs) {
  const native = group.NativeClass.split('.').pop().replace(/'$/, '');
  byNative[native] = group.Classes;
  for (const c of group.Classes) all.push({ native, ...c });
}

const num = (v) => (v === undefined || v === '' ? 0 : Number(v));
const classRefs = (s) => (s ? [...s.matchAll(/\.(\w+_C)['"]/g)].map((m) => m[1]) : []);
const parseAmounts = (s) =>
  s ? [...s.matchAll(/\.(\w+_C)'"?,Amount=([\d.]+)/g)].map((m) => [m[1], Number(m[2])]) : [];

// Footprint = union of the solid clearance boxes (soft boxes and decorative "exclude for snapping"
// boxes are skipped; box rotations are ignored, which is close enough for a floor plan).
function footprint(clearance) {
  const F = '(-?[\\d.]+)';
  const re = new RegExp(
    `(Type=CT_Soft,)?ClearanceBox=\\(Min=\\(X=${F},Y=${F},Z=${F}\\),Max=\\(X=${F},Y=${F},Z=${F}\\),IsValid=True\\)` +
      `(?:,RelativeTransform=\\((?:Rotation=\\([^)]*\\),)?Translation=\\(X=${F},Y=${F},Z=${F}\\)\\))?(,ExcludeForSnapping=True)?`,
    'g',
  );
  let b = null;
  for (const m of (clearance || '').matchAll(re)) {
    if (m[1] || m[11]) continue;
    const [x0, y0, z0, x1, y1, z1] = m.slice(2, 8).map(Number);
    const [tx, ty, tz] = [m[8], m[9], m[10]].map((v) => Number(v || 0));
    const box = [Math.min(x0, x1) + tx, Math.min(y0, y1) + ty, Math.min(z0, z1) + tz, Math.max(x0, x1) + tx, Math.max(y0, y1) + ty, Math.max(z0, z1) + tz];
    b = b ? [0, 1, 2].map((i) => Math.min(b[i], box[i])).concat([3, 4, 5].map((i) => Math.max(b[i], box[i]))) : box;
  }
  if (!b) return { w: 8, l: 8, h: 8 };
  const r = (v) => Math.round(v / 10) / 10; // cm -> m, 0.1 m precision
  return { w: r(b[3] - b[0]), l: r(b[4] - b[1]), h: r(b[5] - b[2]) };
}

// ---------- items ----------
const formOf = { RF_SOLID: 'solid', RF_LIQUID: 'liquid', RF_GAS: 'gas' };
const items = {};
for (const c of all) {
  if (!c.mForm || !c.mDisplayName || !formOf[c.mForm]) continue;
  items[c.ClassName] = {
    id: c.ClassName,
    name: c.mDisplayName,
    form: formOf[c.mForm],
    sink: num(c.mResourceSinkPoints),
    raw: c.native === 'FGResourceDescriptor',
  };
}
const isFluid = (id) => items[id] && items[id].form !== 'solid';
const fluidAmount = (id, amt) => (isFluid(id) ? amt / 1000 : amt);

// ---------- production machines ----------
const machines = {};
for (const native of ['FGBuildableManufacturer', 'FGBuildableManufacturerVariablePower']) {
  for (const b of byNative[native] || []) {
    if (b.ClassName === 'Build_AutomatedWorkBench_C') continue;
    machines[b.ClassName] = {
      id: b.ClassName,
      name: b.mDisplayName,
      power: num(b.mPowerConsumption),
      exp: num(b.mPowerConsumptionExponent) || 1.321929,
      boostExp: num(b.mProductionBoostPowerConsumptionExponent) || 2,
      speed: num(b.mManufacturingSpeed) || 1,
      sloots: num(b.mProductionShardSlotSize),
      variable: native === 'FGBuildableManufacturerVariablePower',
      ...footprint(b.mClearanceData),
    };
  }
}

// ---------- extractors ----------
const extractors = {};
for (const b of byNative.FGBuildableResourceExtractor || []) {
  const isMiner = b.ClassName.startsWith('Build_Miner');
  extractors[b.ClassName] = {
    id: b.ClassName,
    name: b.mDisplayName,
    // rate per minute on a Normal node at 100% clock
    rate: (60 / num(b.mExtractCycleTime)) * (isMiner ? num(b.mItemsPerCycle) : num(b.mItemsPerCycle) / 1000),
    power: num(b.mPowerConsumption),
    kind: isMiner ? 'miner' : 'oil',
    ...footprint(b.mClearanceData),
  };
}
const wp = (byNative.FGBuildableWaterPump || [])[0];
if (wp) {
  extractors[wp.ClassName] = {
    id: wp.ClassName, name: wp.mDisplayName, kind: 'water',
    rate: (60 / num(wp.mExtractCycleTime)) * (num(wp.mItemsPerCycle) / 1000),
    power: num(wp.mPowerConsumption), ...footprint(wp.mClearanceData),
  };
}
const fx = (byNative.FGBuildableFrackingExtractor || [])[0];
const fa = (byNative.FGBuildableFrackingActivator || [])[0];
if (fx && fa) {
  extractors[fx.ClassName] = {
    id: fx.ClassName, name: fx.mDisplayName, kind: 'well',
    rate: (60 / num(fx.mExtractCycleTime)) * (num(fx.mItemsPerCycle) / 1000),
    power: 0, ...footprint(fx.mClearanceData),
  };
  extractors[fa.ClassName] = {
    id: fa.ClassName, name: fa.mDisplayName, kind: 'pressurizer', rate: 0,
    power: num(fa.mPowerConsumption), ...footprint(fa.mClearanceData),
  };
}

// ---------- logistics ----------
const belts = (byNative.FGBuildableConveyorBelt || [])
  .map((b) => ({ id: b.ClassName, name: b.mDisplayName, rate: num(b.mSpeed) / 2 }))
  .sort((a, b) => a.rate - b.rate);
const pipes = (byNative.FGBuildablePipeline || [])
  .filter((p) => !p.ClassName.includes('NoIndicator'))
  .map((p) => ({ id: p.ClassName, name: p.mDisplayName, rate: num(p.mFlowLimit) * 60 }))
  .sort((a, b) => a.rate - b.rate);
const lifts = (byNative.FGBuildableConveyorLift || [])
  .map((b) => ({ id: b.ClassName, name: b.mDisplayName, rate: num(b.mSpeed) / 2 }))
  .sort((a, b) => a.rate - b.rate);

// ---------- recipes ----------
// Building recipes tell us when a building (machine, belt, miner…) becomes available.
const recipes = {};
const buildRecipeToBuilding = {};
for (const r of byNative.FGRecipe) {
  const producedIn = classRefs(r.mProducedIn);
  const products = parseAmounts(r.mProduct);
  if (producedIn.includes('BP_BuildGun_C') || producedIn.includes('FGBuildGun')) {
    for (const [desc] of products) {
      if (desc.startsWith('Desc_')) buildRecipeToBuilding[r.ClassName] = 'Build_' + desc.slice(5);
    }
  }
  const machine = producedIn.find((m) => machines[m]);
  if (!machine) continue;
  const ingredients = parseAmounts(r.mIngredients);
  if (!products.length || products.some(([id]) => !items[id]) || ingredients.some(([id]) => !items[id])) continue;
  const rec = {
    id: r.ClassName,
    name: r.mDisplayName.replace(/^Alternate: /, ''),
    alt: r.mDisplayName.startsWith('Alternate:') || r.ClassName.includes('_Alternate_'),
    machine,
    time: num(r.mManufactoringDuration),
    in: ingredients.map(([id, a]) => [id, fluidAmount(id, a)]),
    out: products.map(([id, a]) => [id, fluidAmount(id, a)]),
  };
  if (machines[machine].variable) {
    rec.pc = num(r.mVariablePowerConsumptionConstant);
    rec.pf = num(r.mVariablePowerConsumptionFactor);
  }
  recipes[rec.id] = rec;
}

// ---------- schematics (milestones, MAM, hard-drive alternates) ----------
const typeOf = {
  EST_Milestone: 'milestone', EST_MAM: 'mam', EST_Alternate: 'alt', EST_Tutorial: 'tutorial', EST_Custom: 'custom',
};
const treeNames = {
  Quartz_RS: 'Quartz', Caterium_RS: 'Caterium', PowerSlugs_RS: 'Power Slugs', AlienOrganisms_RS: 'Alien Organisms',
  Sulfur_RS: 'Sulfur', Mycelia_RS: 'Mycelia', Nutrients_RS: 'Nutrients', XMas_RS: 'FICSMAS', AlienTech_RS: 'Alien Technology',
};
const schematics = [];
for (const s of byNative.FGSchematic) {
  const type = typeOf[s.mType];
  if (!type || s.mDisplayName.startsWith('Discontinued')) continue;
  const unlocked = [];
  const flags = [];
  for (const u of s.mUnlocks || []) {
    unlocked.push(...classRefs(u.mRecipes));
    if (u.Class && !['BP_UnlockRecipe_C', 'BP_UnlockInfoOnly_C', 'BP_UnlockSchematic_C'].includes(u.Class)) flags.push(u.Class);
  }
  const rec = unlocked.filter((id) => recipes[id]);
  const bld = [...new Set(unlocked.map((id) => buildRecipeToBuilding[id]).filter(Boolean))];
  if (type === 'alt' && !rec.length) continue; // inventory slots etc.
  if (type === 'custom' && !rec.length && !bld.length) continue;
  const deps = [];
  for (const d of s.mSchematicDependencies || []) deps.push(...classRefs(d.mSchematics));
  const sch = { id: s.ClassName, name: s.mDisplayName, type, tier: num(s.mTechTier), recipes: rec, buildings: bld, deps };
  if (type === 'mam') sch.tree = treeNames[s.FullName.split('/Research/')[1]?.split('/')[0]] || 'Other';
  if (flags.length) sch.flags = [...new Set(flags)];
  schematics.push(sch);
}
schematics.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

// Recipes that are not unlocked by any schematic (e.g. available from the start) are treated as always available.
const unlockedSomewhere = new Set(schematics.flatMap((s) => s.recipes));
const alwaysRecipes = Object.keys(recipes).filter((id) => !unlockedSomewhere.has(id));

// Keep only items that matter to production.
const usedItems = new Set();
for (const r of Object.values(recipes)) for (const [id] of [...r.in, ...r.out]) usedItems.add(id);
for (const id of Object.keys(items)) if (!usedItems.has(id) && !items[id].raw) delete items[id];

const out = { version: path.basename(install), items, recipes, machines, extractors, belts, pipes, lifts, schematics, alwaysRecipes };
fs.writeFileSync('src/data/gameData.json', JSON.stringify(out));

// ---------- resource nodes ----------
const nodesRaw = JSON.parse(fs.readFileSync('scripts/source/nodes_vanilla.json', 'utf8'));
const purity = { Impure: 'impure', Normal: 'normal', Pure: 'pure' };
const nodeType = { Node: 'node', 'Fracking Satellite': 'well', Geyser: 'geyser' };
const nodes = nodesRaw
  .filter((n) => nodeType[n.node_type])
  .map((n) => ({
    id: n.id,
    item: n.class_name,
    purity: purity[n.purity],
    type: nodeType[n.node_type],
    x: Math.round(n.location.x),
    y: Math.round(n.location.y),
    z: Math.round(n.location.z),
  }));
fs.writeFileSync('src/data/nodes.json', JSON.stringify(nodes));

console.log(
  `items ${Object.keys(items).length}, recipes ${Object.keys(recipes).length}, machines ${Object.keys(machines).length},`,
  `extractors ${Object.keys(extractors).length}, schematics ${schematics.length}, always ${alwaysRecipes.length}, nodes ${nodes.length}`,
);
