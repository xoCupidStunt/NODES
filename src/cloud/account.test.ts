import type { User } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { accountOf } from './CloudProvider';

const user = (provider: string, meta: Record<string, unknown>, email = 'pioneer@example.com') =>
  ({ id: 'u1', email, app_metadata: { provider }, user_metadata: meta }) as unknown as User;

describe('account name', () => {
  it('uses the Discord display name and picture, not the email', () => {
    const a = accountOf(user('discord', { full_name: 'ficsit_alex#0', name: 'ficsit_alex#0', avatar_url: 'https://cdn.discordapp.com/a.png', custom_claims: { global_name: 'Alex' } }));
    expect(a).toEqual({ label: 'Alex', via: 'Discord', avatar: 'https://cdn.discordapp.com/a.png', social: 'Alex' });
  });

  it('falls back to the Discord username when there is no display name', () => {
    expect(accountOf(user('discord', { full_name: 'ficsit_alex#0' })).label).toBe('ficsit_alex');
  });

  it('shows the email for email sign-in', () => {
    expect(accountOf(user('email', {})).label).toBe('pioneer@example.com');
  });
});
