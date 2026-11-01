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
- **Setup** — product, target rate or "as much as possible", and the build goal: maximum output, power efficiency, or minimal area. Switch off recipes you don't want, add extra supply, import parts from other factories.
- **Map & placement** — all 608 resource nodes. *Suggest placement* finds the spot with the shortest belts to enough free nodes (and to factories you import from) and claims them; or place manually and claim nodes by clicking. Highlights the nearest free nodes and factories with parts to spare. You can load your own map image as a background.
- **Results** — machines per recipe, clock speeds (equal or "N at 100% + 1 odd"), shards, power, extraction setup per node, a layout (flow) diagram with belt/pipe tiers, and optimisation suggestions (bottlenecks, alternates worth hunting, belts, byproducts, somersloops…).
- **Schematic** — to-scale floor plan on an 8 m foundation grid: machine rows with manifolds, a belt bus, input/output ports, floors with lifts, perimeter walls, power poles. Adjust machine spacing, row walkways, machines per row, floors, snapping, and hide belts under the floor or behind walls. Includes a bill of materials. Export as SVG/PNG or print.

## Game data

`src/data/gameData.json` is generated from the game's own `CommunityResources/Docs/en-US.json`. After a game update:

```
npm run extract -- "D:/SteamLibrary/steamapps/common/Satisfactory"
```

Resource node positions come from [satisfactory_node_heatmap](https://github.com/Hirashi3630/satisfactory_node_heatmap) (MIT), stored in `scripts/source/nodes_vanilla.json`.

## Tests

```
npm test
```
