# Twight landing page

Static marketing site for the Chrome extension.

## Deploy on Vercel (recommended)

1. Connect this **repo** to Vercel.
2. Set **Root Directory** to empty / project root (**not** `marketing`).
3. Framework preset: Other. No build command needed for static HTML.
4. Repo root `vercel.json` rewrites `/` → `/marketing/index.html`.

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
