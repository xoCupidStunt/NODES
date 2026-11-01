# N.O.D.E.S

**Node Optimization & Deployment Efficiency System**

A local web app for planning Satisfactory (1.x) factories: what to build, how many, clock settings, where to put it, and a to-scale build schematic.

## Run it

```
npm install
npm run dev
```
Then open http://localhost:5173. Everything you enter is saved in your browser; use **Export / Import** in the sidebar to back it up or move it.

## Features

- **Progress** — pick your tier (ticks milestones), then adjust milestones, MAM research, hard-drive alternates, power shards and somersloops. Only unlocked machines, belts, miners and recipes are used.
- **Game sync** — Chrome and Edge won't open folders inside AppData, where the game saves. Run `public/nodes-save-helper.ps1` once (right-click → Run with PowerShell, or download it from the Progress page): it starts with Windows and copies the newest saves to `DocumentsN.O.D.E.S Saves`. Then, on the Progress page, connect that folder once. N.O.D.E.S reads your newest save whenever the game saves and fills in tier, milestones, MAM research, alternates, power shards and somersloops. Nodes that already have a miner in your game are marked on the map and skipped by *Suggest placement*. Saves are read in the browser; nothing is uploaded. Folder sync needs Chrome or Edge; other browsers can drag a `.sav` file onto the page.
- **Power** — generators (biomass, coal, fuel, nuclear; geothermal in synced saves) are production machines and power (MW) is a product: plan a power plant by choosing Power as the product, see power made vs. used, and power plants are found in your save like any factory.
- **Built factory overview** — factories added from your game open on their own page instead of the planner steps: products and inputs, every machine with clocks, rates and power, an efficiency overview (output vs. what is possible, power per item, machine count, clock use, resource use), and suggested changes, and Generate schematic / Show on map. Suggestions start from what is really built: extractor output at its in-game clocks, the recipes it already runs, and only changes whose inputs are actually spare (a resource is only called limiting if more of it alone raises output). "Plan changes…" opens the planner tools.
- **Combine / separate** — on the Progress page, tick factories found in your game to combine them, or separate one that is really several buildings (split wherever machines are more than a chosen distance apart, with a preview). The same works for factories already in the planner (Setup page); linked ones stay linked. A factory can now make several products ("Also make" on Setup).
- **World map** — every factory on one map: the ones in the planner (with their nodes and imports) and the ones built in your game that are not added yet, with their footprints. Click one for details, to rename it, or to add it.
- **Factories from your game** — after a sync, the Progress page lists the factories in your save (machines joined by belts or pipes), with product, output rate, power and mined nodes, named after nearby map markers or train stations. Add them with one click; they stay linked, so each sync updates them. Results then compares what's built with the planner's best plan for the same output.
- **Setup** — product, target rate or "as much as possible", and the build goal: maximum output, power efficiency, or minimal area. Switch off recipes you don't want, add extra supply, import parts from other factories.
- **Map & placement** — all 608 resource nodes. *Suggest placement* finds the spot with the shortest belts to enough free nodes (and to factories you import from) and claims them; or place manually and claim nodes by clicking. Highlights the nearest free nodes and factories with parts to spare. The world map picture comes from the [Satisfactory Wiki](https://satisfactory.fandom.com/wiki/Map) (game art © Coffee Stain Studios); it is loaded from the wiki, not stored in this repo, and can be hidden or faded.
- **Results** — machines per recipe, clock speeds (equal or "N at 100% + 1 odd"), shards, power, extraction setup per node, a layout (flow) diagram with belt/pipe tiers, and optimisation suggestions (bottlenecks, alternates worth hunting, belts, byproducts…).
- **Schematic** — to-scale floor plan on an 8 m foundation grid: machine rows with manifolds, a belt bus, input/output ports, floors with lifts, perimeter walls, power poles. Adjust machine spacing, row walkways, machines per row, floors, snapping, and hide belts under the floor or behind walls. Includes a bill of materials. Export as SVG/PNG or print.

## Game data

`src/data/gameData.json` is generated from the game's own `CommunityResources/Docs/en-US.json`. After a game update:

```
npm run extract -- "D:/SteamLibrary/steamapps/common/Satisfactory"
```

Resource node positions come from [satisfactory_node_heatmap](https://github.com/Hirashi3630/satisfactory_node_heatmap) (MIT), stored in `scripts/source/nodes_vanilla.json`.

Save files are read with [satisfactory-file-parser](https://github.com/etothepii4/satisfactory-file-parser) (MIT). If a game update changes the save format, update that package.

## Tests

```
npm test
```
