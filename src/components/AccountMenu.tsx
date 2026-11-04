import { useEffect, useRef, useState } from 'react';
import { accountOf, useCloud } from '../cloud/CloudProvider';
import { useStore } from '../state';
import { SaveSyncCard } from './SaveSyncCard';

/** Account button in the top right corner, with its menu. */
export function AccountMenu() {
  const c = useCloud();
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [open]);

  const who = c.user ? accountOf(c.user) : null;
  const go = () => { dispatch({ type: 'view', view: 'profile' }); setOpen(false); };
  return (
    <div className="account-menu" ref={box}>
      <button className={`account-button ${state.view === 'profile' ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={who ? `${c.name} — account` : 'Account'}>
        {who?.avatar ? (
          <img src={who.avatar} alt="" referrerPolicy="no-referrer" />
        ) : c.name ? (
          <span>{c.name.slice(0, 1).toUpperCase()}</span>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" /></svg>
        )}
      </button>
      {open && (
        <div className="account-dropdown" role="menu">
          {who && <div className="account-dropdown-head"><b>{c.name}</b>{who.via && <span className="muted small-text">{who.via}</span>}</div>}
          <button role="menuitem" onClick={go}>Your Account</button>
        </div>
      )}
    </div>
  );
}

/** The "Your account" page: who you're signed in as, and syncing from your game. */
export function ProfilePage() {
  const c = useCloud();
  return (
    <div className="content">
      <h1>Your account</h1>
      {c.enabled && c.user && <ProfileCard />}
      <SaveSyncCard />
    </div>
  );
}

function ProfileCard() {
  const c = useCloud();
  const who = accountOf(c.user!);
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await c.setName(name); } catch { /* shown below */ } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h2>Profile</h2>
      {c.error && <p className="warn-text">{c.error}</p>}
      <div className="row gap wrap account-who">
        {who.avatar && <img className="avatar" src={who.avatar} alt="" referrerPolicy="no-referrer" />}
        <span className="muted">Signed in{who.via ? ` with ${who.via}` : ''} as <b>{who.label}</b></span>
        <button className="small ghost" onClick={() => void c.signOut()}>Sign out</button>
      </div>
      <form className="row gap wrap" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name other players see <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
        <button className="small" disabled={busy || !name.trim() || name.trim() === c.name}>Save</button>
      </form>
    </section>
  );
}
