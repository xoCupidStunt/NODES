import { useEffect, useState } from 'react';
import { providers } from '../cloud/client';
import { accountOf, useCloud, type Member, type World } from '../cloud/CloudProvider';

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.5 0L8.6 3a19.7 19.7 0 0 0-4.9 1.4C.6 9-.3 13.6.2 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4a12.9 12.9 0 0 1-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.5-13.7ZM8.5 15.4c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm7 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  );
}
import { KEY, loadFrom, useStore } from '../state';

const PROVIDER_NAMES: Record<string, string> = { discord: 'Discord', google: 'Google', github: 'GitHub', twitch: 'Twitch' };

/** Sidebar: who you're signed in as, which world is open, who else is in it. */
export function CloudBox() {
  const c = useCloud();
  const { state, dispatch } = useStore();
  if (!c.enabled) return null;
  const open = () => dispatch({ type: 'view', view: 'account' });
  if (!c.user) {
    return (
      <button className={`nav ${state.view === 'account' ? 'on' : ''}`} onClick={open}>
        ☁ Sign in <span className="muted">Save online and plan with friends</span>
      </button>
    );
  }
  const others = c.online.filter((o) => o.user_id !== c.user!.id);
  return (
    <div className={`cloud-box ${state.view === 'account' ? 'on' : ''}`}>
      <div className="row gap cloud-line">
        <span className={`cloud-dot ${c.status}`} title={STATUS_TEXT[c.status]} />
        <select value={c.world?.id ?? ''} onChange={(e) => void c.switchWorld(e.target.value).catch(() => undefined)} aria-label="World" disabled={c.status === 'loading'}>
          {!c.world && <option value="">Loading…</option>}
          {c.worlds.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button className="small ghost" onClick={open} title="Account and sharing">⚙</button>
      </div>
      <div className="muted small-text">
        {STATUS_TEXT[c.status]}
        {others.length > 0 && <> · <span className="ok-text">{others.map((o) => o.name).join(', ')}</span> here now</>}
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  off: 'Offline only',
  out: 'Signed out',
  loading: 'Loading…',
  saved: 'Saved online',
  saving: 'Saving…',
  error: 'Not saved yet',
};

export function AccountPanel() {
  const c = useCloud();
  if (!c.enabled) {
    return (
      <div className="setup">
        <section className="card">
          <h2>Account & sharing</h2>
          <p className="muted">Online saves aren’t set up for this copy of N.O.D.E.S, so your plans are kept in this browser only.</p>
        </section>
      </div>
    );
  }
  return <div className="setup">{c.user ? <SignedIn /> : <SignIn />}</div>;
}

export function SignIn() {
  const c = useCloud();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Discord first: it's the main way in.
  const ordered = [...providers].sort((a, b) => (b === 'discord' ? 1 : 0) - (a === 'discord' ? 1 : 0));
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await c.signInEmail(email);
      setSent(true);
    } catch (e) {
      const m = (e as Error).message;
      setErr(/fetch|network/i.test(m) ? `Couldn’t reach the sign-in server (${m}). Check your connection and try again.` : m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Sign in</h2>
      {c.error && <p className="warn-text">{c.error}</p>}
      {c.pendingJoin && <p className="ok-text">You’ve been invited to a shared world. Sign in and you’ll join it straight away.</p>}
      <p className="muted small-text">
        Signing in saves your plans online, so they’re the same on any computer, and lets you share a world with the people you play with. The first time, the plans in this browser become your own world.
      </p>
      {ordered.length > 0 && (
        <div className="signin-providers">
          {ordered.map((p, i) => (
            <button key={p} className={`signin-provider ${p} ${i === 0 ? 'primary' : ''}`} onClick={() => void c.signInWith(p).catch((e: Error) => setErr(e.message))}>
              {p === 'discord' && <DiscordIcon />}Sign in with {PROVIDER_NAMES[p] ?? p}
            </button>
          ))}
        </div>
      )}
      {ordered.length > 0 && <div className="signin-or"><span>or use email</span></div>}
      {sent ? (
        <p className="ok-text">Check <b>{email}</b> for a sign-in link. Open it in this browser.</p>
      ) : (
        <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" style={{ minWidth: 240 }} />
          <button className={ordered.length ? '' : 'primary'} disabled={busy || !email.includes('@')}>Email me a sign-in link</button>
        </form>
      )}
      {err && <p className="warn-text">{err}</p>}
    </section>
  );
}

function SignedIn() {
  const c = useCloud();
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);
  const [newName, setNewName] = useState('');
  const [from, setFrom] = useState<'empty' | 'current' | 'device'>('empty');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const deviceCount = loadFrom(KEY).factories.length;
  const who = accountOf(c.user!);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try { await job(); } catch { /* shown via c.error */ } finally { setBusy(false); }
  };

  return (
    <>
      {c.error && <p className="warn-text card">{c.error}</p>}
      <section className="card">
        <h2>Your account</h2>
        <div className="row gap wrap account-who">
          {who.avatar && <img className="avatar" src={who.avatar} alt="" referrerPolicy="no-referrer" />}
          <span className="muted">Signed in{who.via ? ` with ${who.via}` : ''} as <b>{who.label}</b></span>
          <button className="small ghost" onClick={() => void c.signOut()}>Sign out</button>
        </div>
        <form className="row gap wrap" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); void run(() => c.setName(name)); }}>
          <label>Name other players see <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
          <button className="small" disabled={busy || !name.trim() || name.trim() === c.name}>Save</button>
        </form>
      </section>

      <section className="card">
        <h2>Worlds</h2>
        <p className="muted small-text">
          A world is one set of plans: progress, factories and the synced save. Everyone in a world sees the same factories, and changes show up for the others as they’re made. Factories in the same world never claim the same nodes.
        </p>
        <div className="world-list">
          {c.worlds.map((w) => <WorldRow key={w.id} w={w} busy={busy} run={run} />)}
        </div>
      </section>

      <section className="card">
        <h2>Join a world</h2>
        <p className="muted small-text">Paste the invite link or code a friend sent you.</p>
        <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); void run(async () => { await c.joinWorld(code); setCode(''); }); }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Invite link or code" style={{ minWidth: 280 }} aria-label="Invite link or code" />
          <button className="primary" disabled={busy || !code.trim()}>Join</button>
        </form>
      </section>

      <section className="card">
        <h2>New world</h2>
        <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); void run(async () => { await c.createWorld(newName, from); setNewName(''); }); }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="World name, e.g. Co-op save" aria-label="World name" style={{ minWidth: 220 }} />
          <select value={from} onChange={(e) => setFrom(e.target.value as typeof from)} aria-label="Start from">
            <option value="empty">Start empty</option>
            <option value="current">Copy the world that’s open</option>
            {deviceCount > 0 && <option value="device">Copy this browser’s offline plans ({deviceCount} factor{deviceCount === 1 ? 'y' : 'ies'})</option>}
          </select>
          <button className="primary" disabled={busy || !newName.trim()}>Create</button>
        </form>
      </section>
    </>
  );
}

function WorldRow({ w, busy, run }: { w: World; busy: boolean; run: (job: () => Promise<void>) => Promise<void> }) {
  const c = useCloud();
  const { dispatch } = useStore();
  const mine = w.owner === c.user!.id;
  const current = c.world?.id === w.id;
  const [open, setOpen] = useState(current);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(w.name);
  useEffect(() => setName(w.name), [w.name]);
  useEffect(() => {
    if (open) c.members(w.id).then(setMembers).catch(() => setMembers([]));
  }, [open, w.id, c.worlds]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = c.inviteLink(w);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select it by hand */ }
  };
  const onlineIds = new Set(c.online.map((o) => o.user_id));

  return (
    <div className={`world-row ${current ? 'on' : ''}`}>
      <div className="row gap wrap">
        <button className="small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
        <b>{w.name}</b>
        {current ? <span className="badge used">open</span> : <button className="small" disabled={busy} onClick={() => void run(async () => { await c.switchWorld(w.id); dispatch({ type: 'view', view: 'progress' }); })}>Open</button>}
        <span className="muted small-text">{mine ? 'yours' : 'shared with you'}{members ? ` · ${members.length} player${members.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {open && (
        <div className="world-detail">
          <div className="row gap wrap">
            <span className="small-text">Invite link</span>
            <input readOnly value={link} onFocus={(e) => e.target.select()} style={{ minWidth: 300, flex: 1 }} aria-label="Invite link" />
            <button className="small" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            {mine && <button className="small ghost" disabled={busy} title="Old links stop working" onClick={() => confirm('Make a new invite link? The old one stops working (players already in stay in).') && void run(() => c.newInvite(w.id))}>New link</button>}
          </div>
          <p className="muted small-text">Anyone with this link can join and edit this world after signing in.</p>
          {members && (
            <ul className="member-list">
              {members.map((m) => (
                <li key={m.user_id}>
                  <span className={`cloud-dot ${current && onlineIds.has(m.user_id) ? 'saved' : 'idle'}`} title={current && onlineIds.has(m.user_id) ? 'Here now' : ''} />
                  {m.display_name ?? 'Player'}{m.user_id === c.user!.id ? ' (you)' : ''}{m.role === 'owner' ? <span className="muted"> · owner</span> : null}
                  {mine && m.user_id !== c.user!.id && (
                    <button className="small ghost" disabled={busy} onClick={() => confirm(`Remove ${m.display_name ?? 'this player'} from ${w.name}?`) && void run(async () => { await c.removeMember(w.id, m.user_id); setMembers(await c.members(w.id)); })}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="row gap wrap">
            {mine && (
              <form className="row gap" onSubmit={(e) => { e.preventDefault(); void run(() => c.renameWorld(w.id, name)); }}>
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="World name" />
                <button className="small" disabled={busy || !name.trim() || name === w.name}>Rename</button>
              </form>
            )}
            {mine ? (
              <button className="small danger ghost" disabled={busy} onClick={() => confirm(`Delete ${w.name} for everyone in it? Its factories are removed and this can’t be undone.`) && void run(() => c.deleteWorld(w.id))}>Delete world</button>
            ) : (
              <button className="small danger ghost" disabled={busy} onClick={() => confirm(`Leave ${w.name}? You can rejoin with an invite link.`) && void run(() => c.leaveWorld(w.id))}>Leave</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
