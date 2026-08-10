# Twight Phase 1 — what you must do before testing

## 1. Run Supabase SQL (required)

1. Open Supabase → SQL Editor
2. Paste and run the contents of `supabase/schema.sql`
3. Confirm tables: `profiles`, `draft_ledger`, `polar_orders`

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

1. Sign in with Google in the side panel
2. Load a Reddit thread → Generate (should use 1 draft)
3. Balance badge decrements
4. Buy on `/pricing` (sign in with Google on the page first) or from the extension — checkout is tied to your account
5. Return to side panel → balance +50

## Polar note

Product delivery: **You deliver it** (webhook credits drafts). Ignore Polar “missing benefit” for license keys.
