// Cloud saves and shared worlds (Supabase). Without keys in the build this does nothing and the app stays offline.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RealtimeChannel, User } from '@supabase/supabase-js';
import { defaultProgress } from '../engine/progression';
import type { GameSync } from '../engine/saveSync';
import type { Factory } from '../engine/types';
import { emptyState, getStorageKey, KEY, loadFrom, normalizeFactory, normalizeGame, setStorageKey, useStore, WORLD_PREF, worldCacheKey, type State } from '../state';
import { authRedirectError, supabase } from './client';
import { applyDocs, changedDocs, docsOf, type DocRow } from './docs';

export interface World { id: string; name: string; owner: string; invite_code: string; created_at: string }
export interface Member { user_id: string; role: 'owner' | 'member'; display_name: string | null }
export interface Online { user_id: string; name: string }
/** off = no cloud in this build; out = signed out (plans stay on this device). */
export type CloudStatus = 'off' | 'out' | 'loading' | 'saved' | 'saving' | 'error';

interface CloudCtx {
  enabled: boolean;
  /** Whether sign-in state is known yet (false briefly at startup). */
  authReady: boolean;
  user: User | null;
  name: string;
  status: CloudStatus;
  error: string | null;
  worlds: World[];
  world: World | null;
  online: Online[];
  /** An invite link was opened while signed out. */
  pendingJoin: boolean;
  signInEmail: (email: string) => Promise<void>;
  signInWith: (provider: string) => Promise<void>;
  signOut: () => Promise<void>;
  setName: (name: string) => Promise<void>;
  createWorld: (name: string, from: 'empty' | 'current' | 'device') => Promise<void>;
  joinWorld: (codeOrLink: string) => Promise<void>;
  switchWorld: (id: string) => Promise<void>;
  renameWorld: (id: string, name: string) => Promise<void>;
  newInvite: (id: string) => Promise<void>;
  leaveWorld: (id: string) => Promise<void>;
  deleteWorld: (id: string) => Promise<void>;
  members: (id: string) => Promise<Member[]>;
  removeMember: (id: string, userId: string) => Promise<void>;
  inviteLink: (w: World) => string;
}

const Ctx = createContext<CloudCtx | null>(null);
/** Tells this browser tab's own writes apart from other players' when they echo back. */
const CLIENT = Math.random().toString(36).slice(2, 12);
const JOIN_PREF = 'nodes-join';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** Bring a doc from the cloud up to the current shape, like plans saved on this device. */
function normalizeRow(r: DocRow): DocRow {
  if (r.data == null) return { key: r.key, data: null };
  if (r.key.startsWith('factory:')) return { key: r.key, data: normalizeFactory(r.data as Factory) };
  if (r.key === 'progress') return { key: r.key, data: { ...defaultProgress, ...(r.data as object) } };
  if (r.key === 'game') return { key: r.key, data: normalizeGame(r.data as GameSync) };
  return r;
}

/** Remove every world copy cached in this browser, and which world was open. */
function forgetWorldCopies() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(`${KEY}@`)) localStorage.removeItem(k);
    localStorage.removeItem(WORLD_PREF);
  } catch {
    /* storage blocked */
  }
}

/** Plain-English next step for common sign-in failures. */
function hintFor(msg: string) {
  if (/email.*(external|provider)|unverified email/i.test(msg)) return ' Your Discord account needs a verified email address (Discord → User Settings → My Account), or sign in with the email link instead.';
  if (/provider is not enabled|unsupported provider/i.test(msg)) return ' Discord sign-in isn’t switched on in Supabase yet (Authentication → Sign In / Providers → Discord).';
  if (/exchange|client|secret|invalid_client/i.test(msg)) return ' Check the Discord Client ID and Client Secret saved in Supabase match the Discord app’s OAuth2 page.';
  if (/expired|invalid/i.test(msg)) return ' The link may have expired; try signing in again.';
  if (/database/i.test(msg)) return ' Check the database setup script (supabase/schema.sql) ran without errors.';
  return '';
}

const nameOf = (u: User | null) => (u ? ((u.user_metadata?.name as string | undefined) ?? u.email?.split('@')[0] ?? 'Pioneer') : '');
const codeFrom = (s: string) => {
  const t = s.trim();
  try { return new URL(t).searchParams.get('join') ?? t; } catch { return t; }
};
const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

export function CloudProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const [user, setUser] = useState<User | null>(null);
  const [authKnown, setAuthKnown] = useState(false);
  const [status, setStatus] = useState<CloudStatus>(supabase ? 'out' : 'off');
  const [error, setError] = useState<string | null>(authRedirectError ? `Sign-in didn’t finish: ${authRedirectError}.${hintFor(authRedirectError)}` : null);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldId, setWorldId] = useState<string | null>(null);
  const [online, setOnline] = useState<Online[]>([]);
  const [pendingJoin, setPendingJoin] = useState(() => !!store.get(JOIN_PREF));

  const stateRef = useRef(state);
  stateRef.current = state;
  const userRef = useRef(user);
  userRef.current = user;
  /** The world being synced, what the cloud holds for it, and whether the store shows it yet. */
  const worldRef = useRef<string | null>(null);
  const pushed = useRef(new Map<string, unknown>());
  const loaded = useRef<State | null>(null);
  const ready = useRef(false);
  const channel = useRef<RealtimeChannel | null>(null);
  const pushing = useRef(false);
  const again = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout>>();

  // An invite link: remember the code (it survives the sign-in email round trip) and tidy the address bar.
  // A failed sign-in: open the sign-in page so its message is seen.
  useEffect(() => {
    if (supabase && authRedirectError) dispatch({ type: 'view', view: 'account' });
  }, [dispatch]);

  useEffect(() => {
    if (!supabase) return;
    const code = new URLSearchParams(location.search).get('join');
    if (!code) return;
    store.set(JOIN_PREF, code);
    setPendingJoin(true);
    const url = new URL(location.href);
    url.searchParams.delete('join');
    history.replaceState(null, '', url.toString());
    dispatch({ type: 'view', view: 'account' });
  }, [dispatch]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user ?? null); setAuthKnown(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, session) => { setUser(session?.user ?? null); setAuthKnown(true); });
    return () => data.subscription.unsubscribe();
  }, []);

  const refreshWorlds = useCallback(async () => {
    const { data, error: e } = await supabase!.from('worlds').select('id,name,owner,invite_code,created_at').order('created_at');
    fail(e);
    setWorlds(data as World[]);
    return data as World[];
  }, []);

  /** Send what changed since the cloud last heard from this tab. */
  const push = useCallback(async () => {
    const id = worldRef.current;
    if (!supabase || !id || !ready.current) return;
    if (pushing.current) { again.current = true; return; }
    const next = docsOf(stateRef.current);
    const rows = changedDocs(pushed.current, next);
    if (!rows.length) return;
    pushing.current = true;
    setStatus('saving');
    const { error: e } = await supabase.from('world_docs').upsert(rows.map((r) => ({ world_id: id, key: r.key, data: r.data, client: CLIENT })));
    pushing.current = false;
    if (worldRef.current !== id) return;
    if (e) {
      setStatus('error');
      setError(`Couldn’t save to the cloud: ${e.message}. Your changes are kept on this device and will be retried.`);
      clearTimeout(retry.current);
      retry.current = setTimeout(() => void push(), 10000);
      return;
    }
    for (const r of rows) pushed.current.set(r.key, r.data == null ? null : next.get(r.key));
    setStatus('saved');
    setError(null);
    if (again.current) { again.current = false; void push(); }
  }, []);

  useEffect(() => {
    if (state === loaded.current) ready.current = true;
    if (!worldRef.current || !ready.current) return;
    const t = setTimeout(() => void push(), 700);
    return () => clearTimeout(t);
  }, [state, push]);

  // Save straight away when the tab is hidden or closed.
  useEffect(() => {
    const now = () => { if (document.visibilityState === 'hidden') void push(); };
    document.addEventListener('visibilitychange', now);
    return () => document.removeEventListener('visibilitychange', now);
  }, [push]);

  /** Take other players' changes, except where this tab has its own not yet saved (those win and get sent). */
  const merge = useCallback((rows: DocRow[]) => {
    const cur = docsOf(stateRef.current);
    const fresh = rows.map(normalizeRow).filter((r) => cur.get(r.key) === pushed.current.get(r.key));
    if (!fresh.length) return;
    for (const r of fresh) pushed.current.set(r.key, r.data);
    dispatch({ type: 'remote', rows: fresh });
  }, [dispatch]);

  const fetchDocs = useCallback(async (id: string, keys?: string[]) => {
    let q = supabase!.from('world_docs').select('key,data').eq('world_id', id);
    if (keys) q = q.in('key', keys);
    const { data, error: e } = await q;
    fail(e);
    return data as DocRow[];
  }, []);

  const listen = useCallback((id: string) => {
    if (channel.current) void supabase!.removeChannel(channel.current);
    setOnline([]);
    const me = userRef.current;
    let queued = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscribed = false;
    const ch = supabase!.channel(`world:${id}`, { config: { presence: { key: me?.id ?? CLIENT } } });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'world_docs', filter: `world_id=eq.${id}` }, (p) => {
      const row = p.new as { key?: string; client?: string } | undefined;
      if (!row?.key || row.client === CLIENT) return;
      queued.add(row.key);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const keys = [...queued];
        queued = new Set();
        if (worldRef.current === id) fetchDocs(id, keys).then((rows) => worldRef.current === id && merge(rows)).catch(() => undefined);
      }, 250);
    });
    ch.on('presence', { event: 'sync' }, () => {
      const seen = new Map<string, Online>();
      for (const list of Object.values(ch.presenceState<Online>())) for (const o of list) seen.set(o.user_id, { user_id: o.user_id, name: o.name });
      setOnline([...seen.values()]);
    });
    ch.subscribe((s) => {
      if (s !== 'SUBSCRIBED') return;
      void ch.track({ user_id: me?.id ?? CLIENT, name: nameOf(me) });
      // After a dropped connection, catch up on anything missed.
      if (subscribed) fetchDocs(id).then((rows) => worldRef.current === id && merge(rows)).catch(() => undefined);
      subscribed = true;
    });
    channel.current = ch;
  }, [fetchDocs, merge]);

  const openWorld = useCallback(async (id: string) => {
    await push();
    worldRef.current = null;
    ready.current = false;
    setStatus('loading');
    setError(null);
    const cached = loadFrom(worldCacheKey(id));
    let s: State;
    try {
      const rows = (await fetchDocs(id)).map(normalizeRow);
      const cur = stateRef.current;
      s = applyDocs({ ...emptyState(), sync: cur.sync, view: cur.view === 'account' || cur.view === 'world' ? cur.view : 'progress' }, rows);
      const last = cached.activeId && s.factories.some((f) => f.id === cached.activeId) ? cached.activeId : s.factories[0]?.id ?? null;
      s = { ...s, activeId: last, view: s.view === 'progress' && last && cached.view !== 'progress' && cached.view !== 'account' ? cached.view : s.view };
      setStatus('saved');
    } catch (e) {
      // Offline: show the copy cached on this device; edits are sent once the cloud answers again.
      s = { ...cached, sync: stateRef.current.sync };
      setStatus('error');
      setError(`Couldn’t reach the cloud (${(e as Error).message}). Showing the copy saved on this device.`);
    }
    pushed.current = docsOf(s);
    loaded.current = s;
    worldRef.current = id;
    setStorageKey(worldCacheKey(id));
    store.set(WORLD_PREF, id);
    setWorldId(id);
    dispatch({ type: 'load', state: s });
    listen(id);
  }, [dispatch, fetchDocs, listen, push]);

  /** Write a whole state into a (new, empty) world. */
  const upload = useCallback(async (id: string, s: State) => {
    const rows = changedDocs(new Map(), docsOf(s)).filter((r) => r.data != null);
    const { error: e } = await supabase!.from('world_docs').upsert(rows.map((r) => ({ world_id: id, key: r.key, data: r.data, client: CLIENT })));
    fail(e);
  }, []);

  const guard = useCallback(async (job: () => Promise<void>) => {
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
      setStatus((s) => (s === 'loading' ? 'error' : s));
      throw e;
    }
  }, []);

  // Signing in opens your world (making one from this device's plans the first time); signing out goes back to them.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!supabase) return;
    if (!authKnown) return;
    if (!userId) {
      if (channel.current) void supabase.removeChannel(channel.current);
      channel.current = null;
      worldRef.current = null;
      loaded.current = null;
      ready.current = false;
      setWorlds([]);
      setOnline([]);
      setWorldId(null);
      setStatus('out');
      // Signed out: drop this browser's copies of the worlds, so the next person here sees nothing of them.
      forgetWorldCopies();
      if (getStorageKey() !== KEY) {
        setStorageKey(KEY);
        dispatch({ type: 'load', state: loadFrom(KEY) });
      }
      return;
    }
    let live = true;
    void guard(async () => {
      setStatus('loading');
      let list = await refreshWorlds();
      let target: string | null = null;
      const code = store.get(JOIN_PREF);
      if (code) {
        store.set(JOIN_PREF, null);
        setPendingJoin(false);
        const { data, error: e } = await supabase!.rpc('join_world', { p_code: code, p_display: nameOf(userRef.current) });
        if (e) setError(`Couldn’t join: ${e.message}`);
        else { target = data as string; list = await refreshWorlds(); }
      }
      if (!list.length) {
        // First sign-in: your own world, starting with the plans on this device.
        const { data, error: e } = await supabase!.rpc('create_world', { p_name: `${nameOf(userRef.current)}’s world`, p_display: nameOf(userRef.current) });
        fail(e);
        await upload(data as string, loadFrom(KEY));
        // They live in the account now; don't leave them for whoever uses this browser next.
        store.set(KEY, null);
        list = await refreshWorlds();
        target = data as string;
      }
      const pref = store.get(WORLD_PREF);
      target ??= list.some((w) => w.id === pref) ? pref : list[0].id;
      if (live) await openWorld(target!);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [userId, authKnown]); // eslint-disable-line react-hooks/exhaustive-deps

  const redirect = () => location.origin + location.pathname;

  const value = useMemo<CloudCtx>(() => {
    const ensure = () => { if (!supabase) throw new Error('Cloud saves aren’t set up in this build'); return supabase; };
    const leaveTo = async (gone: string) => {
      const list = await refreshWorlds();
      if (worldRef.current !== gone) return;
      if (list.length) return openWorld(list[0].id);
      const { data, error: e } = await ensure().rpc('create_world', { p_name: `${nameOf(userRef.current)}’s world`, p_display: nameOf(userRef.current) });
      fail(e);
      await refreshWorlds();
      return openWorld(data as string);
    };
    return {
      enabled: !!supabase,
      authReady: authKnown,
      user,
      name: nameOf(user),
      status,
      error,
      worlds,
      world: worlds.find((w) => w.id === worldId) ?? null,
      online,
      pendingJoin,
      signInEmail: async (email) => {
        const { error: e } = await ensure().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirect() } });
        fail(e);
      },
      signInWith: async (provider) => {
        const { error: e } = await ensure().auth.signInWithOAuth({ provider: provider as 'discord', options: { redirectTo: redirect() } });
        fail(e);
      },
      signOut: async () => {
        await push();
        await ensure().auth.signOut();
      },
      setName: (name) => guard(async () => {
        const sb = ensure();
        const { data, error: e } = await sb.auth.updateUser({ data: { name: name.trim() } });
        fail(e);
        if (data.user) setUser(data.user);
        await sb.from('world_members').update({ display_name: name.trim() }).eq('user_id', data.user!.id);
        if (channel.current) void channel.current.track({ user_id: data.user!.id, name: name.trim() });
      }),
      createWorld: (name, from) => guard(async () => {
        const { data, error: e } = await ensure().rpc('create_world', { p_name: name, p_display: nameOf(user) });
        fail(e);
        const id = data as string;
        if (from === 'current') await upload(id, stateRef.current);
        if (from === 'device') await upload(id, loadFrom(KEY));
        await refreshWorlds();
        await openWorld(id);
      }),
      joinWorld: (codeOrLink) => guard(async () => {
        const { data, error: e } = await ensure().rpc('join_world', { p_code: codeFrom(codeOrLink), p_display: nameOf(user) });
        fail(e);
        await refreshWorlds();
        await openWorld(data as string);
      }),
      switchWorld: (id) => guard(() => openWorld(id)),
      renameWorld: (id, name) => guard(async () => {
        fail((await ensure().from('worlds').update({ name: name.trim() || 'My world' }).eq('id', id)).error);
        await refreshWorlds();
      }),
      newInvite: (id) => guard(async () => {
        fail((await ensure().rpc('new_invite_code', { w: id })).error);
        await refreshWorlds();
      }),
      leaveWorld: (id) => guard(async () => {
        fail((await ensure().from('world_members').delete().eq('world_id', id).eq('user_id', user!.id)).error);
        await leaveTo(id);
      }),
      deleteWorld: (id) => guard(async () => {
        fail((await ensure().from('worlds').delete().eq('id', id)).error);
        store.set(worldCacheKey(id), null);
        await leaveTo(id);
      }),
      members: async (id) => {
        const { data, error: e } = await ensure().from('world_members').select('user_id,role,display_name').eq('world_id', id).order('joined_at');
        fail(e);
        return data as Member[];
      },
      removeMember: (id, uid) => guard(async () => {
        fail((await ensure().from('world_members').delete().eq('world_id', id).eq('user_id', uid)).error);
      }),
      inviteLink: (w) => `${redirect()}?join=${w.invite_code}`,
    };
  }, [user, authKnown, status, error, worlds, worldId, online, pendingJoin, guard, openWorld, push, refreshWorlds, upload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCloud() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCloud outside CloudProvider');
  return c;
}
