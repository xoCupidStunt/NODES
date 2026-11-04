import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** True for Supabase keys that bypass access rules: these must never reach the browser. */
function isSecretKey(key: string) {
  if (key.startsWith('sb_secret_')) return true;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

export default defineConfig(({ mode }) => {
  // Reads .env files and the host's variables (e.g. Vercel). Only the named Supabase values below go to the browser.
  const env = loadEnv(mode, process.cwd(), '');
  const found: string[] = [];
  const pick = (...names: string[]) => {
    const n = names.find((x) => env[x]?.trim());
    if (n) found.push(n);
    return n ? env[n].trim() : '';
  };
  // Plain names, plus the ones Vercel's Supabase integration and other frameworks use.
  const url = pick('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const key = pick(
    'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY',
  );
  const providers = pick('SUPABASE_PROVIDERS', 'VITE_SUPABASE_PROVIDERS');
  if (process.env.VERCEL || mode === 'production') {
    // Shows up in the Vercel build log (names only, never values) to make setup problems easy to spot.
    const seen = Object.keys(env).filter((k) => /SUPABASE/i.test(k));
    console.log(`[N.O.D.E.S] Online saves: ${url && key ? 'ON' : 'OFF'} — using ${found.join(', ') || 'nothing'}. ` +
      `Supabase variables seen: ${seen.join(', ') || 'none'}${process.env.VERCEL_ENV ? ` (Vercel environment: ${process.env.VERCEL_ENV})` : ''}.`);
  }
  if (key && isSecretKey(key)) {
    throw new Error('The Supabase key set for the app is a secret/service_role key. Use the publishable (sb_publishable_…) or anon key instead.');
  }
  return {
    plugins: [react()],
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_KEY__: JSON.stringify(key),
      __SUPABASE_PROVIDERS__: JSON.stringify(providers),
    },
  };
});
