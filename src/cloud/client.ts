import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** The cloud backend, or null when this build has no Supabase keys (the app then works offline only). */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;

/** Extra sign-in buttons, e.g. VITE_SUPABASE_PROVIDERS=discord,google (each must be enabled in Supabase). */
export const providers = ((import.meta.env.VITE_SUPABASE_PROVIDERS as string | undefined) ?? '')
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
