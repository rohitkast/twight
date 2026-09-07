# Twight

Chrome extension (MV3) that reads a Reddit post and its comments, then drafts
natural replies, comments, and DMs. Hosted generation (Gemini) is billed in
**drafts** against a Supabase profile — not a user-pasted API key.

Operator setup (SQL, Anonymous provider, redirect URLs, Vercel env) lives in
[SETUP.md](SETUP.md).

## What you get without Google

Opening the side panel creates a **guest session** via Supabase **Anonymous**
auth. That is a real user with no email — a `profiles` row is created at **0**,
then the first guest on this Chrome install is credited **5 free drafts**
(`install_grants`). Sign out creates a *new* anonymous user, but that user gets
**0** on the same install. Reinstalling the extension (new `installId`) can get
another 5.

Generate works immediately for that first guest. Settings shows **Guest** and
**x free drafts**. Sign in, Buy, Refresh, and Sign out stay hidden until they
use Google (Sign in appears on the side panel when free drafts hit 0).

## Google sign-in and linking

**Sign in with Google** (`chrome.identity` → Supabase OAuth) is for more drafts,
Polar checkout, and keeping an identity across devices. Google is asked to show
the account picker (`prompt=select_account`) so you can pick a different Gmail
than the one Chrome is already using.

If they were a guest, leftover free drafts **move** onto the Google account
(whatever is still on the guest profile, e.g. 4 after using 1), then **+5 once**
(`anon_claims` + ledger `google_bonus`). Example: 4 leftover + 5 bonus = **9**,
not 10. The same guest cannot be claimed twice. Google accounts that already
received `signup_bonus` or `google_bonus` do not get another +5.

Buy drafts requires Google (email). Guests cannot check out.

## Other product notes

- On an opened Reddit post, a chip can open the side panel and load the thread.
- Generate does not require a playbook. With no goal, a **Who are you looking
  for?** prompt can save a one-liner as a goal, skip (up to 10 items), or open
  the full Goals page.
- History and Chat List (saved DMs / follow-ups) stay in `chrome.storage.local`.

## Architecture

```
content.ts / reddit-chip.ts  → reddit.com: extract thread; post chip
background.ts                → side panel on icon click or chip
sidepanel.*                  → chat UI, guest session, generate stream
options.*                    → account: Guest vs Google, buy (Google only)
goals.*                      → playbooks (optional)
api/                         → Vercel: /me, /generate, claim-anonymous, checkout
supabase/schema.sql          → profiles, ledger, anon_claims, install_grants
```

Draft generation hits `API_BASE_URL` (see `src/lib/config.ts`) with a Bearer
token. The service worker must not be the only place a guest is created — the
side panel calls `ensureSession()` then `/api/me`.

## Build

```bash
npm install
npm run build        # outputs to dist/
npm run watch        # rebuild on change
```

## Load in Chrome

1. `chrome://extensions` → Developer mode.
2. **Load unpacked** → `dist/`.
3. Open a Reddit post (or click the toolbar icon). Guest drafts appear without
   Google if Anonymous sign-ins are enabled in Supabase.

After source changes: `npm run build`, then reload the extension card.

## Notes

- Reddit extraction targets shreddit (`shreddit-post`, `shreddit-comment`) with
  an old-Reddit fallback. Markup changes belong in `src/content.ts`.
- Existing DB: do not re-run old `CREATE TABLE` for `profiles`. Use `ALTER` +
  new functions/tables as described in [SETUP.md](SETUP.md).
