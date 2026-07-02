# Reddit Reply Assistant — Agent & Developer Guide

## What This App Does

Reddit Reply Assistant is a Chrome extension that helps founders, freelancers, and marketers find and engage with potential clients on Reddit — naturally, without sounding like they are selling anything.

The extension:
- Reads the current Reddit post and its comments from the active tab
- Lets the user describe their goal (e.g. "find freelance clients for UI audits")
- Sends the thread + goal to Claude (Anthropic API) and streams back 1–6 tailored draft replies, comments, or DMs
- Presents each draft as a collapsible card the user can expand, read, copy, and send manually
- Saves every conversation by post URL so the user can review past drafts in a History tab

The tone philosophy is central: Claude is instructed to sound like a real Reddit user — grounded in what specific people wrote, matching the subreddit's culture, never generic marketing language.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension platform | Chrome MV3 (Manifest Version 3) |
| Language | TypeScript |
| Build | esbuild via `build.mjs` — outputs to `dist/` |
| AI | Anthropic SDK (`@anthropic-ai/sdk`), model `claude-sonnet-4-5`, streaming |
| Markdown | `marked` library for fallback assistant bubble rendering |
| Storage | `chrome.storage.local` — API key, goals, chat history |

Build command: `npm run build`
Output: `dist/` (all HTML/CSS/JS assets ready to load as unpacked extension)

---

## Code Structure

```
reddit-extension/
├── public/                  # Static assets copied verbatim to dist/
│   ├── manifest.json        # Chrome MV3 manifest — permissions, entry points
│   ├── sidepanel.html       # Side panel shell HTML
│   ├── sidepanel.css        # All side panel styles (cards, history, bubbles)
│   ├── options.html/css     # Settings page (API key input)
│   └── goals.html/css       # Goals management page (CRUD for user goals)
│
├── src/                     # TypeScript source — compiled by esbuild
│   ├── background.ts        # Service worker: opens side panel on toolbar click
│   ├── content.ts           # Content script injected into reddit.com pages
│   │                          Scrapes post + comments from DOM on EXTRACT_THREAD message
│   ├── sidepanel.ts         # Main side panel controller (all UI logic, streaming, history)
│   ├── options.ts           # Settings page controller (save/load API key)
│   ├── goals.ts             # Goals page controller (CRUD for Goal objects)
│   └── lib/
│       ├── claude.ts        # Anthropic SDK wrapper — prompts, streaming, token budgets
│       └── types.ts         # Shared TypeScript interfaces (RedditThread, Goal, etc.)
│
└── build.mjs                # esbuild bundler script
```

---

## Data & Message Flow

```
Reddit tab (content.ts)
  │  chrome.tabs.sendMessage({ type: "EXTRACT_THREAD" })
  │  → returns ExtractResponse { thread: RedditThread, meta: ExtractMeta }
  ▼
sidepanel.ts
  │  Builds system prompt via claude.ts → buildSystemPrompt()
  │  Streams response via claude.ts → streamReply()
  │  Parses <ITEM>JSON</ITEM> frames incrementally during stream
  │  Renders each draft as a collapsible card (renderDraftFeed)
  │  Saves turns (with structuredDrafts) to chrome.storage.local
  ▼
History tab
  │  Loads SavedConversation objects from chrome.storage
  │  Replays turns using stored structuredDrafts → same card UI as live chat
```

---

## Key Concepts

### Structured Draft Protocol
Claude emits each draft inside an `<ITEM>` frame:
```
<ITEM>{"kind":"dm","targetUser":"username","title":"...","text":"...","rationale":"..."}</ITEM>
```
`kind` is one of `dm | reply | comment`. The sidepanel parses these incrementally during streaming so cards appear as they complete. Partial frames show a "Generating drafts" thinking state instead of raw JSON.

### Token Budget Strategy (claude.ts)
- First turn on a thread: sends full raw thread (capped at 16 comments × 300 chars, relevance-ranked). Requests a `<THREAD_SUMMARY>` block from Claude.
- Subsequent turns: uses only the thread summary (~900 chars) instead of the raw thread to keep the context window small.
- Conversation history sent to API is capped at 6 turns (3 exchanges).

### History Replay
Every assistant turn stores `structuredDrafts: StructuredDraft[]` alongside its plain-text content. When opening a saved conversation, `renderTurn()` calls `renderDraftFeed()` directly with the stored drafts — the exact same rendering path as live chat. Old turns without `structuredDrafts` fall back to re-parsing `turn.content`.

### Modes (sidepanel.ts)
The side panel has three display modes managed by `setMode()`:
- `live` — active chat with composer, goal bar, thread load bar visible
- `history-list` — full-page list of saved conversations (live controls hidden)
- `history-detail` — transcript of a saved conversation (back button visible)

---

## Conventions to Maintain

- **No marketing tone in prompts.** The `BASE_SYSTEM` in `claude.ts` explicitly forbids AI-sounding or marketing language. Do not weaken these instructions.
- **Keep `StructuredDraft` fields stable.** The same interface is used for live rendering, storage, and history replay. Adding fields is fine; removing or renaming breaks saved history.
- **`renderDraftFeed()` is the single source of truth for card rendering.** Both live streaming and history replay must go through this one function. Do not duplicate card rendering logic.
- **Module-level state lives at the top of `sidepanel.ts`.** Keep it grouped and clearly labelled. All UI logic lives inside the `init()` function to avoid accidental global DOM access before the DOM is ready.
- **`lib/claude.ts` is pure — no DOM, no chrome.* calls.** It must stay importable in any environment. All Chrome API calls belong in `sidepanel.ts`, `background.ts`, or `content.ts`.
- **`lib/types.ts` holds only shared interfaces.** No logic, no defaults, no class instances. Keep it the single source of structural truth for cross-file types.
- **Build must stay clean.** Run `npm run build` after every change. Never commit if the build fails.

---

## Improvement Areas (for future agents/developers)

If improving this codebase, consider:

1. **Streamed card reveal** — Currently the entire `renderDraftFeed` is redrawn on each delta. Cards could be appended one by one as each `</ITEM>` frame completes for a smoother stream experience.
2. **Storage migration** — Old saved conversations lack `structuredDrafts`. A one-time migration at startup could re-parse the stored content and backfill the field.
3. **Error recovery** — `streamReply` errors currently replace the bubble with a plain error string. A retry button would improve UX.
4. **Goal-aware ranking** — Comments are currently ranked by keyword overlap with the user message. Incorporating the active goal's description into ranking could improve relevance.
5. **Popup to sidepanel messaging** — If a second entry point (popup) is ever added, the `ExtractResponse` message passing pattern in `content.ts` is already designed to support it cleanly.
