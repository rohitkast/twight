# Reddit Reply Assistant

A Chrome (MV3) extension that reads a Reddit post + comment thread from the page
DOM, opens a side-panel chat, and uses the Claude API to draft tailored replies
and DMs.

## Architecture

```
content.ts      → runs on reddit.com, extracts post + comments from the DOM
background.ts   → service worker, opens the side panel on icon click
sidepanel.*     → chat UI; pulls the thread from the content script and calls Claude
options.*       → stores your Anthropic API key in chrome.storage.local
lib/claude.ts   → @anthropic-ai/sdk wrapper (model, system prompt, streaming)
```

The side panel calls `api.anthropic.com` **directly** from the browser using the
official SDK (`dangerouslyAllowBrowser: true`). Your API key lives only in this
browser's extension storage. This is fine for personal use; do **not** publish
this build, as the key would travel with the extension. (Swap `lib/claude.ts` to
hit a backend proxy if you ever need to distribute it.)

Model: `claude-opus-4-8` with adaptive thinking, streamed into the chat.

## Build

```bash
npm install
npm run build        # outputs to dist/
npm run watch        # rebuild on change
```

## Load in Chrome

1. Visit `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Click the extension's ⚙ (or its options page) and paste your Anthropic API key.

## Use

1. Open a Reddit post.
2. Click the extension icon to open the side panel.
3. Click **Load thread from page**.
4. Ask, e.g. *"Draft a reply to u/someuser"* or *"Write a DM inviting the OP to
   collaborate."* (Ctrl/Cmd+Enter sends.)

## Notes

- Reddit DOM extraction targets the current "shreddit" web-component layout
  (`shreddit-post`, `shreddit-comment`) with a light fallback. If Reddit changes
  its markup, update the selectors in `src/content.ts`.
- After editing source, re-run `npm run build` and hit the reload icon on the
  extension card in `chrome://extensions`.
