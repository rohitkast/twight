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

## 4. Deploy Vercel (required for draft balance)

Push these API changes and redeploy. Then open:

```
https://twight.vercel.app/api/health
```

You should see JSON like `{ "ok": true, "hasServiceRole": true, ... }`.  
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
4. Buy on `/pricing` with **same Google email**
5. Return to side panel → balance +50

## Polar note

Product delivery: **You deliver it** (webhook credits drafts). Ignore Polar “missing benefit” for license keys.
