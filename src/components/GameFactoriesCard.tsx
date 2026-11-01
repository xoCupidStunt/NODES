import { useMemo, useState } from 'react';
import { factoryFromFound, matchFound, type FoundFactory } from '../engine/gameFactories';
import type { Factory } from '../engine/types';
import { newFactory, useStore } from '../state';
import { itemColor, itemName } from '../data/game';
import { fmt, mw } from './ui';

const SMALL = 2; // setups with this many machines or fewer are tucked away

export const foundName = (ff: FoundFactory, names: Record<string, string>) => names[ff.key] ?? ff.name;

/** Found factories, which are already in the planner, and a way to add more. */
export function useFoundFactories() {
  const { state, dispatch } = useStore();
  const found = useMemo(() => state.game?.factories ?? [], [state.game]);
  const { byFound } = useMemo(() => matchFound(found, state.factories), [found, state.factories]);
  const add = (list: FoundFactory[]) => {
    const made: Factory[] = list.map((ff, i) => ({
      ...newFactory(state.factories.length + i + 1),
      ...factoryFromFound(ff, foundName(ff, state.foundNames)),
    }));
    dispatch({ type: 'addMany', factories: made });
  };
  return { found, byFound, add, small: (ff: FoundFactory) => ff.machines <= SMALL };
}

/** Factories found in the synced save, with buttons to name, find and add them. */
export function GameFactoriesCard() {
  const { state, dispatch } = useStore();
  const { found, byFound, add, small } = useFoundFactories();
  const [showSmall, setShowSmall] = useState(false);
  if (!state.game) return null;

  const open = (id: string) => dispatch({ type: 'select', id, view: 'results' });
  const big = found.filter((f) => !small(f));
  const smallOnes = found.filter(small);
  const shown = showSmall ? found : big;
  const newBig = big.filter((f) => !byFound.has(f.key));
  const newAll = found.filter((f) => !byFound.has(f.key));

  return (
    <section id="game-factories" className="card">
      <div className="row between wrap">
        <h2>Factories in your game</h2>
        <div className="row gap">
          <button onClick={() => dispatch({ type: 'showOnMap', focus: null })}>🗺 World map</button>
          {newBig.length > 0 && <button className="primary" onClick={() => add(newBig)}>Add all {newBig.length}</button>}
          {showSmall && newAll.length > newBig.length && <button onClick={() => add(newAll)}>Add all {newAll.length} incl. small</button>}
        </div>
      </div>
      <p className="muted small-text">
        Machines joined by belts or pipes count as one factory. Rename one before adding it if you like. Adding copies its product, output rate, location, mined nodes and outside inputs into the planner, so you can compare it with an optimised plan. Added factories stay linked: each sync updates what’s built.
      </p>
      {found.length === 0 ? (
        <p className="muted">No production machines found in “{state.game.saveName}”.</p>
      ) : (
        <div className="table-scroll">
        <table className="table compact game-factories">
          <thead>
            <tr><th>Name</th><th>Makes (in game, per min)</th><th className="num">Machines</th><th className="num">Power</th><th>Fed by</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((ff) => {
              const linked = byFound.get(ff.key);
              const outside = Object.keys(ff.extraSupply).length;
              return (
                <tr key={ff.key}>
                  <td>
                    {linked
                      ? <b>{linked.name}</b>
                      : <input className="rename" value={foundName(ff, state.foundNames)} onChange={(e) => dispatch({ type: 'renameFound', key: ff.key, name: e.target.value })} aria-label={`Name for ${ff.name}`} />}
                  </td>
                  <td><Makes ff={ff} /></td>
                  <td className="num">{ff.machines}</td>
                  <td className="num">{mw(ff.built.power)}</td>
                  <td className="small-text muted">
                    {ff.nodes.length > 0 && <div>{ff.nodes.length} node{ff.nodes.length > 1 ? 's' : ''}</div>}
                    {outside > 0 && <div title={Object.keys(ff.extraSupply).join(', ')}>{outside} from outside</div>}
                  </td>
                  <td className="actions">
                    <button className="small ghost" onClick={() => dispatch({ type: 'showOnMap', focus: linked ? { kind: 'factory', id: linked.id } : { kind: 'found', id: ff.key } })}>Show on map</button>
                    {linked
                      ? <button className="small ghost" onClick={() => open(linked.id)}>✓ Added</button>
                      : <button className="small" onClick={() => add([ff])}>Add</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      {smallOnes.length > 0 && (
        <button className="small ghost" onClick={() => setShowSmall(!showSmall)}>
          {showSmall ? 'Hide' : 'Show'} {smallOnes.length} small setup{smallOnes.length > 1 ? 's' : ''} ({SMALL} machines or fewer)
        </button>
      )}
    </section>
  );
}

/** Count of found factories not yet added, for the sidebar. */
export function useNewGameFactories() {
  const { found, byFound, small } = useFoundFactories();
  return found.filter((f) => !small(f) && !byFound.has(f.key)).length;
}

/** Every product made at a found factory, main product first. */
export function Makes({ ff }: { ff: FoundFactory }) {
  return (
    <div className="makes">
      {ff.built.outputs
        .slice()
        .sort((a, b) => (a[0] === ff.target ? -1 : b[0] === ff.target ? 1 : b[1] - a[1]))
        .map(([i, v]) => (
          <div key={i} className={i === ff.target ? 'make-main' : ''}><span className="swatch" style={{ background: itemColor(i) }} />{fmt(v)} {itemName(i)}</div>
        ))}
    </div>
  );
}
