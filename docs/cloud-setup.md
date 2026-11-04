# Online saves and shared worlds (Supabase)

N.O.D.E.S works offline with no setup. Plans are saved in the browser. Adding a free Supabase project lets players:

- **Sign in** with an email link, or with Discord or Google if you turn those on. Their plans are then saved online and are the same on every computer.
- **Share a world.** Each player starts with a world of their own, made from the plans in their browser the first time they sign in. Sharing a world's invite link lets friends join it. Everyone in the world sees the same progress, factories, node claims and synced save. Changes show up for the others live, and the sidebar shows who is online.

## One-time setup (about 10 minutes)

1. Create a free project at https://supabase.com. Any name and region will do.
2. Set up the database. In the project, open **SQL Editor → New query**, paste all of [`supabase/schema.sql`](../supabase/schema.sql) and click **Run**. It is safe to run again after updates.
3. Allow sign-in to return to the app. Go to **Authentication → URL Configuration**:
   - **Site URL:** `https://node-system.vercel.app`
   - **Redirect URLs:** add `https://node-system.vercel.app/**` and `http://localhost:5173/**`
4. Copy the keys. Go to **Project Settings → API** (or **Data API**) and copy the **Project URL** and the **anon / publishable** key. The anon key is meant to be public: what each player can see is controlled by the rules in `schema.sql`. Never use the `service_role` / secret key in the app.
5. Add the keys to Vercel. Go to **Project → Settings → Environment Variables**, add the two below (no `VITE_` prefix needed; only these named values reach the browser), then redeploy:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon key
6. For local development, put the same two lines in a file named `.env.local` in the repository root. Git ignores that file.

## Optional: Discord or Google sign-in

1. Turn the provider on under **Authentication → Sign In / Providers**. Supabase walks you through creating the Discord or Google app.
2. Add `SUPABASE_PROVIDERS=discord,google` to Vercel (and `.env.local`) and redeploy.

## Email limits

Supabase's built-in email service sends only a few sign-in emails per hour, which is fine for a small group. For more, add your own SMTP server under **Authentication → Emails → SMTP Settings**.

## How it works

- Each world is stored as separate records: progress, the synced save, combine/separate rules, and one record per factory. Two players editing different factories never overwrite each other. If two people edit the same factory at once, the last change wins.
- The browser keeps a copy of the open world. If the connection drops, the app shows that copy and sends any changes once it's back.
- Plans made while signed out stay in that browser. They can be copied into a world from **Account & sharing → New world**.
- Owners can rename or delete a world, make a new invite link (the old one stops working) and remove players. Other players can leave a world.
