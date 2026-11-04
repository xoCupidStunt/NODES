import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Set at build time from SUPABASE_URL and SUPABASE_ANON_KEY (see vite.config.ts). Empty = no cloud. */
export const cloudConfigured = !!(__SUPABASE_URL__ && __SUPABASE_KEY__);

/**
 * A sign-in that came back with an error (e.g. from Discord or an expired email link) puts it in the address.
 * Read it before the Supabase client tidies the address away, so the app can show it.
 */
export const authRedirectError: string | null = (() => {
  if (typeof location === 'undefined') return null;
  const read = (s: string) => {
    const p = new URLSearchParams(s);
    const msg = p.get('error_description') ?? p.get('error');
    return msg ? msg.replace(/\+/g, ' ') : null;
  };
  const msg = read(location.hash.slice(1)) ?? read(location.search.slice(1));
  if (msg) {
    const url = new URL(location.href);
    for (const k of ['error', 'error_code', 'error_description']) url.searchParams.delete(k);
    history.replaceState(null, '', url.pathname + url.search);
  }
  return msg;
})();

/** The cloud backend, or null when this build has no Supabase keys (the app then works offline only). */
export const supabase: SupabaseClient | null = cloudConfigured ? createClient(__SUPABASE_URL__, __SUPABASE_KEY__) : null;

/** Extra sign-in buttons, e.g. SUPABASE_PROVIDERS=discord,google (each must be enabled in Supabase). */
export const providers = __SUPABASE_PROVIDERS__
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
