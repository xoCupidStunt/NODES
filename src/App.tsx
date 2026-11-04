import { useState } from 'react';
import { MapView } from './components/MapView';
import { ProgressPanel } from './components/ProgressPanel';
import { Results } from './components/Results';
import { SchematicView } from './components/SchematicView';
import { Setup } from './components/Setup';
import { itemName } from './data/game';
import { newFactory, useStore, type View } from './state';
import { rateText } from './components/ui';
import { SyncStatus } from './components/SyncStatus';
import { WorldMap } from './components/WorldMap';
import { BuiltView } from './components/BuiltView';
import { useNewGameFactories } from './components/GameFactoriesCard';
import { AccountPanel, CloudBox } from './components/AccountPanel';
import { AccountMenu, ProfilePage } from './components/AccountMenu';

const TABS: { id: View; label: string }[] = [
  { id: 'setup', label: '1 · Setup' },
  { id: 'map', label: '2 · Map & placement' },
  { id: 'results', label: '3 · Results' },
  { id: 'schematic', label: '4 · Schematic' },
];

export default function App() {
  const { state, dispatch, active, plans } = useStore();
  // Left menu can be hidden for more room; remembered on this device.
  const [sideOpen, setSideOpen] = useState(() => { try { return localStorage.getItem('nodes-sidebar') !== 'closed'; } catch { return true; } });
  const toggleSide = (open: boolean) => {
    setSideOpen(open);
    try { localStorage.setItem('nodes-sidebar', open ? 'open' : 'closed'); } catch { /* storage blocked: just don't remember */ }
  };
  // Factory list can be folded away; remembered on this device.
  const [listOpen, setListOpen] = useState(() => { try { return localStorage.getItem('nodes-factories') !== 'closed'; } catch { return true; } });
  const toggleList = () => {
    setListOpen(!listOpen);
    try { localStorage.setItem('nodes-factories', listOpen ? 'closed' : 'open'); } catch { /* storage blocked */ }
  };
  const newInGame = useNewGameFactories();
  // Combine mode: tick factories in the list, pick which one keeps its name and settings.
  const [combining, setCombining] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [keep, setKeep] = useState<string | null>(null);
  const pickedNow = picked.filter((id) => state.factories.some((f) => f.id === id));
  const keepId = keep && pickedNow.includes(keep) ? keep : pickedNow[0] ?? null;
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const stopCombining = () => { setCombining(false); setPicked([]); setKeep(null); };
  const combine = () => {
    if (!keepId || pickedNow.length < 2) return;
    const others = pickedNow.filter((id) => id !== keepId);
    const name = (id: string) => state.factories.find((f) => f.id === id)?.name ?? '';
    if (!confirm(`Combine ${others.map(name).join(', ')} into ${name(keepId)}?\n\nTheir products, nodes and supply move into ${name(keepId)} and they are removed from the list. Factories from your game stay linked as one.`)) return;
    dispatch({ type: 'combineFactories', ids: [keepId, ...others] });
    dispatch({ type: 'select', id: keepId });
    stopCombining();
  };
  const showGameFactories = () => {
    dispatch({ type: 'view', view: 'progress' });
    setTimeout(() => document.getElementById('game-factories')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  return (
    <div className={`app ${sideOpen ? '' : 'side-closed'}`}>
      {!sideOpen && <button className="side-open" onClick={() => toggleSide(true)} title="Show menu" aria-label="Show menu">☰</button>}
      <aside className="sidebar" hidden={!sideOpen}>
        <div className="brand">
          <span className="logo">N</span>
          <div>
            <div className="brand-title">N.O.D.E.S</div>
            <div className="brand-sub">Node Optimization &amp; Deployment Efficiency System</div>
          </div>
          <button className="side-close" onClick={() => toggleSide(false)} title="Hide menu" aria-label="Hide menu">«</button>
        </div>
        <CloudBox />
        <button className={`nav ${state.view === 'progress' ? 'on' : ''}`} onClick={() => dispatch({ type: 'view', view: 'progress' })}>
          ⚙ Progress <span className="muted">Tier {state.progress.tier} · {state.progress.mam.length} MAM · {state.progress.alts.length} alts</span>
        </button>
        <SyncStatus />
        <button className={`nav ${state.view === 'world' ? 'on' : ''}`} onClick={() => dispatch({ type: 'showOnMap', focus: null })}>
          🗺 World map <span className="muted">All factories{state.game ? ' · planned and in game' : ''}</span>
        </button>
        <div className="side-head">
          <button className="list-toggle" onClick={toggleList} aria-expanded={listOpen} title={listOpen ? 'Hide factories' : 'Show factories'}>
            <span className="caret">{listOpen ? '▾' : '▸'}</span> Factories <span className="count">{state.factories.length}</span>
          </button>
          <div className="row gap">
            {listOpen && state.factories.length > 1 && (
              <button className={`small ${combining ? 'on' : ''}`} onClick={() => (combining ? stopCombining() : setCombining(true))} title="Combine factories">{combining ? 'Cancel' : 'Combine'}</button>
            )}
            {!combining && <button className="small" onClick={() => dispatch({ type: 'add', factory: newFactory(state.factories.length + 1) })}>+ New</button>}
          </div>
        </div>
        {listOpen && combining && (
          <div className="combine-bar">
            <div className="small-text">{pickedNow.length < 2 ? 'Tick the factories to combine.' : <>Combine {pickedNow.length} into:</>}</div>
            {pickedNow.length >= 2 && (
              <select value={keepId ?? ''} onChange={(e) => setKeep(e.target.value)} aria-label="Factory to keep">
                {pickedNow.map((id) => <option key={id} value={id}>{state.factories.find((f) => f.id === id)?.name}</option>)}
              </select>
            )}
            <button className="small primary" disabled={pickedNow.length < 2} onClick={combine}>Combine {pickedNow.length >= 2 ? pickedNow.length : ''}</button>
          </div>
        )}
        {newInGame > 0 && (
          <button className="small ingame-hint" onClick={showGameFactories}>⇩ {newInGame} factor{newInGame > 1 ? 'ies' : 'y'} found in your game</button>
        )}
        <div className="factory-list" hidden={!listOpen}>
          {state.factories.length === 0 && <p className="muted pad">No factories yet. Click “+ New” to plan one.</p>}
          {state.factories.map((f) => {
            const p = plans[f.id];
            return (
              <button key={f.id} className={`factory-item ${combining ? (pickedNow.includes(f.id) ? 'picked' : '') : f.id === state.activeId && state.view !== 'progress' && state.view !== 'world' ? 'on' : ''}`} onClick={() => (combining ? togglePick(f.id) : dispatch({ type: 'select', id: f.id }))}>
                <div className="fi-name">{combining && <input type="checkbox" readOnly checked={pickedNow.includes(f.id)} tabIndex={-1} className="fi-check" />}{f.name}{f.game && <span className="ingame-tag" title={f.game.missing ? "Not found in the last synced save" : "Linked to a factory in your save"}>{f.game.missing ? "gone?" : "in game"}</span>}</div>
                <div className="muted">
                  {p?.status === 'ok' ? `${rateText(f.target, p.rate)} ` : ''}{itemName(f.target)}
                  {f.location ? ' · placed' : ''}
                </div>
              </button>
            );
          })}
        </div>
      </aside>
      <AccountMenu />
      <main className="main">
        {state.view === 'profile' ? (
          <ProfilePage />
        ) : state.view === 'account' ? (
          <AccountPanel />
        ) : state.view === 'world' ? (
          <WorldMap />
        ) : state.view === 'progress' || !active ? (
          state.view === 'progress' ? <ProgressPanel /> : <Welcome />
        ) : active.game && state.view === 'built' ? (
          <BuiltView f={active} />
        ) : (
          <>
            <header className="top">
              {active.game ? (
                <div className="built-title">
                  <button className="small ghost" onClick={() => dispatch({ type: 'view', view: 'built' })}>← Overview</button>
                  <b className="title-static">{active.name}</b>
                  <span className="ingame-tag">built in game</span>
                </div>
              ) : (
                <input className="title-input" value={active.name} onChange={(e) => dispatch({ type: 'update', id: active.id, patch: { name: e.target.value } })} aria-label="Factory name" />
              )}
              {active.game && state.view === 'schematic' ? (
                <span className="muted small-text">Generated schematic — visual reference only</span>
              ) : (
                <nav className="tabs">
                  {active.game && <span className="muted small-text">Planning changes:</span>}
                  {TABS.map((t) => (
                    <button key={t.id} className={state.view === t.id ? 'on' : ''} onClick={() => dispatch({ type: 'view', view: t.id })}>{t.label}</button>
                  ))}
                </nav>
              )}
            </header>
            <div className="content">
              {(state.view === 'setup' || state.view === 'built') && <Setup f={active} />}
              {state.view === 'map' && <MapView f={active} />}
              {state.view === 'results' && <Results f={active} />}
              {state.view === 'schematic' && <SchematicView f={active} />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Welcome() {
  const { state, dispatch } = useStore();
  return (
    <div className="welcome">
      <h1>Welcome to N.O.D.E.S</h1>
      <p className="muted">Node Optimization &amp; Deployment Efficiency System — plan a Satisfactory factory from node to build.</p>
      <ol>
        <li>Set your <b>Progress</b> — tier, MAM research and hard-drive alternates — so only buildings and recipes you have are used.</li>
        <li>Create a factory, pick the product and how to optimise it.</li>
        <li>Place it on the map; the planner claims the nearest free resource nodes.</li>
        <li>Read the equipment list and clock settings, then generate a to-scale build schematic.</li>
      </ol>
      <button className="primary" onClick={() => dispatch({ type: 'add', factory: newFactory(state.factories.length + 1) })}>+ New factory</button>
    </div>
  );
}
