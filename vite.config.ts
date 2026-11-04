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
  const pick = (...names: string[]) => names.map((n) => env[n]?.trim()).find(Boolean) ?? '';
  const url = pick('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const key = pick('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY');
  const providers = pick('SUPABASE_PROVIDERS', 'VITE_SUPABASE_PROVIDERS');
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
