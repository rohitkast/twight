# Twight Phase 1 — what you must do before testing

## 1. Run Supabase SQL (required)

1. Open Supabase → SQL Editor
2. Paste and run the contents of `supabase/schema.sql`
3. Confirm tables: `profiles`, `draft_ledger`, `polar_orders`, `anon_claims`, `install_grants`

If the project already had Phase 1 tables, still re-run from `handle_new_user` through the end of `schema.sql` (guest **5 per install**, Google **0** until claim, claim + install RPCs).

New guests get **5** drafts **once per Chrome install**, not once per Sign out. Sign out creates a new anonymous `auth.users` + `profiles` row, but `register_install_grant` credits +5 only for the first guest on that `installId`. Google sign-in moves leftover guest drafts and adds **+5 once**. Reinstall can mint another guest 5.

**If Sign out still shows 5 free drafts**, the live DB is still giving 5 in `handle_new_user`. Re-run that function and `register_install_grant` from `schema.sql`, then deploy the API.

## 1b. Enable Anonymous sign-ins (required for generate without Google)

Supabase → Authentication → Providers → **Anonymous** → enable.

Without this, the side panel cannot create a guest session and Generate will still ask for Google.

## 2. Supabase Auth redirect URL (required for Chrome sign-in)

Supabase → Authentication → URL Configuration → Redirect URLs → add **both**:

```
https://knoflcakdhglkbfkickfpiepnphpbiii.chromiumapp.org/auth
https://fpoaifndhjgaicoghecihpekgnhbiffb.chromiumapp.org/auth
```

- First = local unpacked / Dev Mode ID  
- Second = Chrome Web Store ID  

(Also keep your existing Supabase Google callback.)

Add web pricing sign-in redirects:

```
http://localhost:3000/pricing
https://twight.vercel.app/pricing
```

## 3. Vercel env vars (confirm these exist)

| Name | Notes |
|---|---|
| `SUPABASE_URL` | `https://rcbnajyufootjbpncwxz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | secret |
| `SUPABASE_ANON_KEY` | optional but recommended |
| `GOOGLE_AI_API_KEY` | secret |
| `POLAR_ACCESS_TOKEN` | secret (`polar_oat_…`) |
| `POLAR_WEBHOOK_SECRET` | secret from webhook endpoint |
| `POLAR_ORGANIZATION_ID` | `c512dec2-9c86-4ea6-b112-e7b486c7d013` |
| `POLAR_PRODUCT_ID` | `8e149b00-a6af-4db6-9829-7b983438c08f` |
| `POLAR_SERVER` | **`sandbox`** if token is from sandbox.polar.sh; omit/`production` for live |
| `POLAR_SANDBOX` | alternate: `1` or `true` → same as `POLAR_SERVER=sandbox` |
| `PUBLIC_APP_URL` | optional — e.g. `https://twight.vercel.app` (checkout success redirect) |

Re-run the `add_drafts_from_order` function in `supabase/schema.sql` if your DB predates user-id checkout linking.

## 3b. Local dev — avoid swapping Polar keys

`npx vercel dev` injects **production** env from the Vercel dashboard. You do **not** need to change dashboard keys to test locally.

**Put sandbox-only values in `.env.local`** (gitignored). On local dev, `.env.local` **overrides** cloud env for the same variable names.

Example `.env.local` (you edit — never commit):

```
POLAR_SERVER=sandbox
POLAR_ACCESS_TOKEN=...sandbox token...
POLAR_PRODUCT_ID=...sandbox product...
POLAR_WEBHOOK_SECRET=...sandbox webhook...
```

Restart: `npx vercel dev` → `curl http://localhost:3000/api/health` should show `"localEnvOverrides": true`, `"polarServer": "sandbox"`.

### Skip Polar entirely (fastest local UI test)

Add to `.env.local`:

```
MOCK_CHECKOUT=true
```

Buy drafts will **credit +50 drafts in Supabase** and open `/success` — no Polar, no payment. Disabled automatically on Vercel Production.

Health check: `"mockCheckout": true`.

### When you go live

- Production Polar keys stay in **Vercel Dashboard → Production** only
- Remove `MOCK_CHECKOUT` from any deployed env
- `.env.local` is never deployed — no key swapping at ship time

**If checkout says `polarServerConfigured: false`**, `POLAR_SERVER` is missing from `.env.local` and cloud env. Add it locally and restart `vercel dev`.

## 4. Deploy Vercel (required for draft balance)

Push these API changes and redeploy. Then open:

```
https://twight.vercel.app/api/health
```

You should see JSON like `{ "ok": true, "hasServiceRole": true, "polarServer": "sandbox", ... }`.  
Test Polar token: `https://twight.vercel.app/api/health?probePolar=1` → `polarTokenOk: true`.  
If `hasServiceRole` is `false`, add `SUPABASE_SERVICE_ROLE_KEY` in Vercel env and redeploy.

Until `/api/me` works, the extension badge stays on `… drafts`.

## 5. Load the extension

```bash
npm run build
```

Chrome → `chrome://extensions` → Load unpacked → `dist/`

## 6. Smoke test

1. Open the side panel on a Reddit post — you should be a **guest** with **5 free drafts** (no Google).
2. Load a thread → Generate (uses 1 draft). Balance decrements. Sign in stays hidden until 0 drafts.
3. Sign in with Google — leftover guest drafts move over (e.g. 4 left → **9**, not 10), **+5 once**. Settings shows your email; Buy / Sign out appear.
4. Buy on `/pricing` or from the extension (Google only). Return to the side panel → balance +50.
5. Google Sign out, then reopen the panel — same Chrome install should **not** get another 5 guest drafts.

## Polar note

Product delivery: **You deliver it** (webhook credits drafts). Ignore Polar “missing benefit” for license keys.
