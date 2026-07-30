# Twight landing page

Static marketing site for the Chrome extension. Open `index.html` from this folder in a browser, or deploy the files below to any static host.

## Files to deploy together

When hosting **only** the marketing site (not the whole repo), copy these paths so links keep working:

```
marketing/
  index.html
  assets/icon-128.png
  styles/landing.css
public/
  rra-tokens.css
  sidepanel.css
```

Or host the whole repository and point your domain at `marketing/index.html`.

## Local preview

From the repo root:

```bash
npx --yes serve marketing -p 3456
```

Then open `http://localhost:3456` — you still need `../public/*.css` reachable (serve from repo root instead if previews break):

```bash
npx --yes serve . -p 3456
# open http://localhost:3456/marketing/
```

## Chrome Web Store

Install link is set in `index.html` to the Twight listing.

## Icons

- **Extension** (`public/icons/`): Twight **T** monogram on orange. Used by `manifest.json` (16 / 48 / 128).
- **Landing** (`marketing/assets/icon-128.png`): **Stack of lines** mark (second line orange and longer = the comment that matters). Used in nav and favicon.

Regenerate or replace those PNGs if you redesign the brand; keep filenames the same.
