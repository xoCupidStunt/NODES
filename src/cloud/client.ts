import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Set at build time from SUPABASE_URL and SUPABASE_ANON_KEY (see vite.config.ts). Empty = no cloud. */
export const cloudConfigured = !!(__SUPABASE_URL__ && __SUPABASE_KEY__);

/** The cloud backend, or null when this build has no Supabase keys (the app then works offline only). */
export const supabase: SupabaseClient | null = cloudConfigured ? createClient(__SUPABASE_URL__, __SUPABASE_KEY__) : null;

/** Extra sign-in buttons, e.g. SUPABASE_PROVIDERS=discord,google (each must be enabled in Supabase). */
export const providers = __SUPABASE_PROVIDERS__
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
