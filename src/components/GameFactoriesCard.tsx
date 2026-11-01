import { useMemo, useState } from 'react';
import { factoryFromFound, matchFound, type FoundFactory } from '../engine/gameFactories';
import type { Factory } from '../engine/types';
import { newFactory, useStore } from '../state';
import { ItemTag, mw } from './ui';

const SMALL = 2; // setups with this many machines or fewer are tucked away

/** Factories found in the synced save, with buttons to add them to the planner. */
export function GameFactoriesCard() {
  const { state, dispatch } = useStore();
  const [showSmall, setShowSmall] = useState(false);
  const found = state.game?.factories ?? [];
  const { byFound } = useMemo(() => matchFound(found, state.factories), [found, state.factories]);
  if (!state.game) return null;

  const make = (ff: FoundFactory, i: number): Factory => ({ ...newFactory(state.factories.length + i + 1), ...factoryFromFound(ff) });
  const add = (list: FoundFactory[]) => dispatch({ type: 'addMany', factories: list.map(make) });
  const open = (id: string) => dispatch({ type: 'select', id, view: 'results' });

  const big = found.filter((f) => f.machines > SMALL);
  const small = found.filter((f) => f.machines <= SMALL);
  const shown = showSmall ? found : big;
  const newBig = big.filter((f) => !byFound.has(f.key));
  const newAll = found.filter((f) => !byFound.has(f.key));

  return (
    <section id="game-factories" className="card">
      <div className="row between wrap">
        <h2>Factories in your game</h2>
        <div className="row gap">
          {newBig.length > 0 && <button className="primary" onClick={() => add(newBig)}>Add all {newBig.length}</button>}
          {showSmall && newAll.length > newBig.length && <button onClick={() => add(newAll)}>Add all {newAll.length} incl. small</button>}
        </div>
      </div>
      <p className="muted small-text">
        Machines joined by belts or pipes count as one factory. Adding one copies its product, output rate, location, mined nodes and outside inputs into the planner, so you can compare it with an optimised plan. Factories you add stay linked: each sync updates what’s built.
      </p>
      {found.length === 0 ? (
        <p className="muted">No production machines found in “{state.game.saveName}”.</p>
      ) : (
        <table className="table compact game-factories">
          <thead>
            <tr><th>Name</th><th>Makes (in game)</th><th className="num">Machines</th><th className="num">Power</th><th>Fed by</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((ff) => {
              const linked = byFound.get(ff.key);
              const outside = Object.keys(ff.extraSupply).length;
              return (
                <tr key={ff.key}>
                  <td><b>{ff.name}</b></td>
                  <td><ItemTag item={ff.target} rate={ff.rate} />{ff.built.outputs.length > 1 && <span className="muted small-text"> +{ff.built.outputs.length - 1} more</span>}</td>
                  <td className="num">{ff.machines}</td>
                  <td className="num">{mw(ff.built.power)}</td>
                  <td className="small-text muted">
                    {ff.nodes.length ? `${ff.nodes.length} node${ff.nodes.length > 1 ? 's' : ''}` : ''}
                    {ff.nodes.length && outside ? ' + ' : ''}
                    {outside ? `${outside} input${outside > 1 ? 's' : ''} from outside` : ''}
                  </td>
                  <td className="num">
                    {linked
                      ? <button className="small ghost" onClick={() => open(linked.id)}>✓ {linked.name}</button>
                      : <button className="small" onClick={() => add([ff])}>Add</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {small.length > 0 && (
        <button className="small ghost" onClick={() => setShowSmall(!showSmall)}>
          {showSmall ? 'Hide' : 'Show'} {small.length} small setup{small.length > 1 ? 's' : ''} ({SMALL} machines or fewer)
        </button>
      )}
    </section>
  );
}

/** Count of found factories not yet added, for the sidebar. */
export function useNewGameFactories() {
  const { state } = useStore();
  return useMemo(() => {
    const found = (state.game?.factories ?? []).filter((f) => f.machines > SMALL);
    const { byFound } = matchFound(found, state.factories);
    return found.filter((f) => !byFound.has(f.key)).length;
  }, [state.game, state.factories]);
}

