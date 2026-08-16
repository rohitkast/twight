# Twight landing page

Static marketing site for the Chrome extension.

## Deploy on Vercel (recommended)

1. Connect this **repo** to Vercel.
2. **Root Directory:** empty or `./` (repo root).
3. **Framework preset:** Other.
4. **Output Directory:** `vercel-static` (or leave blank — `vercel.json` sets it).
5. **Build command:** leave blank — `vercel.json` runs `npm run build:vercel`, which copies `marketing/` and `public/` into `vercel-static/`.
6. **Install command:** leave blank (optional).

`vercel.json` rewrites `/` → `/marketing/index.html`, `/tips` → `/marketing/tips.html`, `/pricing` → `/marketing/pricing.html`.

Styles and assets use absolute paths:

- `/marketing/...` for landing CSS and icons
- `/public/rra-tokens.css` and `/public/sidepanel.css` for the panel mock

## Local preview

From the repo root (so `/public` and `/marketing` resolve the same way as Vercel):

```bash
npx --yes serve . -p 3456
# open http://localhost:3456/
```

## Chrome Web Store

Install link is set in `index.html` to the Twight listing.

## Icons

- **Extension** (`public/icons/`): Twight **T** monogram on orange. Used by `manifest.json` (16 / 48 / 128).
- **Landing** (`marketing/assets/icon-128.png`): **Stack of lines** mark (second line orange and longer = the comment that matters). Used in nav and favicon.

Regenerate or replace those PNGs if you redesign the brand; keep filenames the same.
