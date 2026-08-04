import { buildSystemPrompt, buildConversionSystemPrompt, type ChatTurn } from "./lib/claude";
import { ApiError, fetchMe, streamGenerate } from "./lib/api";
import { getCurrentUser, signInWithGoogle } from "./lib/auth";
import { BYOK_ENABLED, PRICING_URL } from "./lib/config";
import type { RedditThread, ExtractResponse, Goal, ScrollToUserResponse } from "./lib/types";
import { marked } from "marked";

// BYOK path parked — re-enable with BYOK_ENABLED + restore getClient/streamReply imports.
void BYOK_ENABLED;

// ---- Module-level state ----

let thread: RedditThread | null = null;
let activeGoal: Goal | null = null;
let hasLoaded = false;

type DraftKind = "dm" | "reply" | "comment";

interface StructuredDraft {
  kind: DraftKind;
  targetUser: string | null;
  title: string;
  text: string;
  rationale: string;
}

/** A saved turn with optional structured drafts for faithful history replay. */
type ConversationTurn = ChatTurn & {
  structuredDrafts?: StructuredDraft[];
  structuredRemainder?: string;
  /** When true, this user turn was auto-generated (no instruction typed) and should not render in the UI. */
  hidden?: boolean;
};

const history: ConversationTurn[] = [];
let conversationSummary = "";
let threadSummary = "";

const MAX_SUMMARY_CHARS = 1200;
const CHAT_HISTORY_KEY = "chatHistoryByPost";
const MAX_HISTORY_ITEMS = 100;
const INCLUDE_COMMENTS_KEY = "includeCommentsInDrafts";
const MODEL_PROVIDER_KEY = "modelProvider";
const STREAM_TIMEOUT_MS = 30_000;
const TRACKED_USERS_KEY = "trackedUsers";
const TRACKED_USERS_WARN_THRESHOLD = 30;
const TRACKED_USERS_MAX = 50;
const ITEM_OPEN = "<ITEM>";
const ITEM_CLOSE = "</ITEM>";
const FEEDBACK_STATE_KEY = "feedbackState";
const FEEDBACK_WEBHOOK = "https://discord.com/api/webhooks/1523667772339519519/T5CZ076q-EKJjAopvpcwYVhzNA2L2M4tZ3kiqyf4dIA7RO-RBaBXnyvUEO89_Gfeu3tH";
const MAX_FEEDBACK_SESSIONS = 3;

interface FeedbackState {
  submitted: boolean;
  sessionsTried: number;
}

let shownFeedbackThisSession = false;

interface TrackedUser {
  id: string;
  savedAt: number;
  username: string;
  kind: DraftKind;
  originalDraft: string;
  postTitle: string;
  postUrl: string;
  subreddit: string;
  threadSummary: string;
  goalName: string;
  goalDescription: string;
  followUpTurns: ChatTurn[];
}

interface SavedConversation {
  postKey: string;
  title: string;
  subreddit: string;
  author: string;
  url: string;
  commentsCount: number;
  turns: ConversationTurn[];
  summary: string;
  threadSummary?: string;
  updatedAt: number;
}

type SavedConversationMap = Record<string, SavedConversation>;

const ALLOWED_MD_TAGS = new Set([
  "a", "p", "br", "strong", "em", "code", "pre",
  "ul", "ol", "li", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
};

marked.setOptions({ gfm: true, breaks: true });

// ---- Pure helpers ----

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function sanitizeMarkdownHtml(rawHtml: string): string {
  const doc = new DOMParser().parseFromString(`<div>${rawHtml}</div>`, "text/html");
  const root = doc.body.firstElementChild as HTMLElement;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_MD_TAGS.has(tag)) { el.replaceWith(...Array.from(el.childNodes)); continue; }
    const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
    for (const attr of Array.from(el.attributes)) {
      if (!allowed.has(attr.name)) el.removeAttribute(attr.name);
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) {
        el.removeAttribute("href");
      } else {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  }
  return root.innerHTML;
}

function renderMarkdown(content: string): string {
  return sanitizeMarkdownHtml(marked.parse(content) as string);
}

function truncateConversationSummary(userMessage: string, assistantMessage: string): void {
  const nextLine = `U: ${truncate(userMessage, 180)}\nA: ${truncate(assistantMessage, 260)}`;
  conversationSummary = conversationSummary ? `${conversationSummary}\n${nextLine}` : nextLine;
  if (conversationSummary.length > MAX_SUMMARY_CHARS) {
    conversationSummary = `...\n${conversationSummary.slice(conversationSummary.length - MAX_SUMMARY_CHARS)}`;
  }
}

function parseThreadSummaryBlock(text: string): { visibleText: string; extractedSummary: string } {
  const s = text.indexOf("<THREAD_SUMMARY>");
  if (s === -1) return { visibleText: text, extractedSummary: "" };
  const before = text.slice(0, s).trimEnd();
  const e = text.indexOf("</THREAD_SUMMARY>", s + 16);
  if (e === -1) return { visibleText: before, extractedSummary: "" };
  const summaryText = text.slice(s + 16, e).trim();
  const after = text.slice(e + 17).trim();
  return { visibleText: [before, after].filter(Boolean).join("\n\n").trim(), extractedSummary: summaryText };
}

function draftKindLabel(kind: DraftKind): string {
  if (kind === "dm") return "DM";
  if (kind === "reply") return "Reply";
  return "Comment";
}

function normalizeHumanPunctuation(value: string): string {
  return value
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")
    .replace(/\s+--\s+/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeTargetUser(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/^u\//i, "").replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || null;
}

function normalizeStructuredDraft(raw: unknown): StructuredDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kindRaw = String(obj.kind ?? "").toLowerCase();
  if (kindRaw !== "dm" && kindRaw !== "reply" && kindRaw !== "comment") return null;
  const text = typeof obj.text === "string" ? normalizeHumanPunctuation(obj.text) : "";
  if (!text) return null;
  const title = typeof obj.title === "string" ? normalizeHumanPunctuation(obj.title) : "";
  const rationale = typeof obj.rationale === "string" ? normalizeHumanPunctuation(obj.rationale) : "";
  return {
    kind: kindRaw,
    targetUser: sanitizeTargetUser(obj.targetUser),
    title: title || `${draftKindLabel(kindRaw)} draft`,
    text,
    rationale,
  };
}

function parseStructuredDrafts(text: string): {
  drafts: StructuredDraft[]; remainder: string; hasPartialFrame: boolean;
} {
  const drafts: StructuredDraft[] = [];
  let cursor = 0;
  let remainder = "";
  while (cursor < text.length) {
    const start = text.indexOf(ITEM_OPEN, cursor);
    if (start === -1) { remainder += text.slice(cursor); break; }
    remainder += text.slice(cursor, start);
    const end = text.indexOf(ITEM_CLOSE, start + ITEM_OPEN.length);
    if (end === -1) return { drafts, remainder: remainder + text.slice(start), hasPartialFrame: true };
    const payload = text.slice(start + ITEM_OPEN.length, end).trim();
    try {
      const draft = normalizeStructuredDraft(JSON.parse(payload));
      if (draft) drafts.push(draft);
    } catch { remainder += `${text.slice(start, end + ITEM_CLOSE.length)}\n`; }
    cursor = end + ITEM_CLOSE.length;
  }
  return { drafts, remainder: remainder.trim(), hasPartialFrame: false };
}

function serializeDraftsForHistory(drafts: StructuredDraft[], remainder: string): string {
  const blocks = drafts.map((d) => {
    const target = d.targetUser ? ` to u/${d.targetUser}` : "";
    const rationale = d.rationale ? `\nReason: ${d.rationale}` : "";
    return `### ${draftKindLabel(d.kind)}${target}\n${d.text}${rationale}`;
  });
  if (remainder.trim()) blocks.push(remainder.trim());
  return blocks.join("\n\n").trim();
}

function firstSentencePreview(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const i = clean.search(/[.!?](\s|$)/);
  return truncate(i >= 0 ? clean.slice(0, i + 1) : clean, max);
}

function fallbackThreadSummary(t: RedditThread): string {
  const topComments = t.comments.slice(0, 5).map((c) => `- u/${c.author}: ${truncate(c.body, 120)}`).join("\n");
  return [
    `Subreddit: ${t.subreddit || "?"}`,
    `Post author: u/${t.author || "?"}`,
    `Title: ${truncate(t.title || "(untitled)", 220)}`,
    t.body ? `Body: ${truncate(t.body, 320)}` : "",
    `Top comments (${Math.min(t.comments.length, 5)} of ${t.comments.length}):`,
    topComments || "- none captured",
  ].filter(Boolean).join("\n");
}

async function trySendMessage(tabId: number): Promise<ExtractResponse | null> {
  try { return (await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_THREAD" })) as ExtractResponse; }
  catch { return null; }
}

function getPostKey(t: RedditThread | null): string | null {
  if (!t) return null;
  return t.url || `${t.subreddit}|${t.author}|${t.title}`;
}

async function getSavedConversationMap(): Promise<SavedConversationMap> {
  const { [CHAT_HISTORY_KEY]: raw = {} } = (await chrome.storage.local.get(CHAT_HISTORY_KEY)) as { [CHAT_HISTORY_KEY]?: SavedConversationMap };
  return raw;
}

async function setSavedConversationMap(map: SavedConversationMap): Promise<void> {
  await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: map });
}

async function getTrackedUsers(): Promise<TrackedUser[]> {
  const { [TRACKED_USERS_KEY]: raw = [] } = (await chrome.storage.local.get(TRACKED_USERS_KEY)) as { [TRACKED_USERS_KEY]?: TrackedUser[] };
  return raw;
}

async function setTrackedUsers(users: TrackedUser[]): Promise<void> {
  await chrome.storage.local.set({ [TRACKED_USERS_KEY]: users });
}

async function saveTrackedUser(user: TrackedUser): Promise<void> {
  const users = await getTrackedUsers();
  const alreadyExists = users.some((u) => u.username === user.username && u.postUrl && u.postUrl === user.postUrl);
  if (alreadyExists) {
    showToast(`u/${user.username} is already in your chat list for this post.`);
    return;
  }
  if (users.length >= TRACKED_USERS_MAX) {
    showToast("Chat list is full (50 max). Open Chat List and delete some old contacts.");
    return;
  }
  users.unshift(user);
  await setTrackedUsers(users);
  showToast(`Saved u/${user.username} to Chat List ✓`);
}

async function saveCurrentConversation(): Promise<void> {
  const postKey = getPostKey(thread);
  if (!postKey || history.length === 0 || !thread) return;
  const map = await getSavedConversationMap();
  map[postKey] = {
    postKey,
    title: thread.title || "(untitled)",
    subreddit: thread.subreddit || "?",
    author: thread.author || "?",
    url: thread.url || "",
    commentsCount: thread.comments.length,
    turns: history.slice(),
    summary: conversationSummary,
    threadSummary,
    updatedAt: Date.now(),
  };
  const entries = Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY_ITEMS);
  const trimmed: SavedConversationMap = {};
  for (const item of entries) trimmed[item.postKey] = item;
  await setSavedConversationMap(trimmed);
}

// ---- UI rendering helpers ----

function showToast(message: string, durationMs = 3000): void {
  const existing = document.getElementById("rra-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "rra-toast";
  toast.className = "rra-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  // Trigger CSS transition
  requestAnimationFrame(() => toast.classList.add("visible"));
  window.setTimeout(() => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, durationMs);
}

async function scrollToUserInTab(username: string): Promise<void> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showToast("Could not access the active tab.");
    return;
  }

  if (!tab?.id || !/reddit\.com/.test(tab.url ?? "")) {
    showToast("Switch to the Reddit tab first, then click the username.");
    return;
  }

  let resp: ScrollToUserResponse;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "SCROLL_TO_USER", username });
  } catch {
    showToast("Could not reach the page — try refreshing the Reddit tab.");
    return;
  }

  if (!resp.ok) {
    if (resp.error === "user_not_found") {
      showToast(`u/${username} not found on this page — they may not have a visible comment loaded.`);
    } else {
      showToast("Could not scroll to that user.");
    }
  }
}

async function copyTextWithFeedback(btn: HTMLButtonElement, text: string): Promise<void> {
  const original = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch { btn.textContent = "Failed"; }
  finally { window.setTimeout(() => { btn.textContent = original; }, 1200); }
}

function renderThinkingState(bubble: HTMLElement): void {
  bubble.classList.add("structured", "thinking");
  bubble.innerHTML =
    `<div class="thinking-row">` +
    `<span class="thinking-label">Generating drafts</span>` +
    `<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
    `</div>`;
}

/**
 * Renders a list of StructuredDraft objects as cards inside bubble.
 * Used both during streaming (live) and when replaying saved history.
 */
function renderDraftFeed(
  bubble: HTMLElement,
  drafts: StructuredDraft[],
  remainder: string,
  hasPartialFrame: boolean,
  onSave?: (draft: StructuredDraft) => void,
): void {
  bubble.classList.add("structured");
  bubble.classList.remove("thinking");
  bubble.innerHTML = "";

  const feed = document.createElement("div");
  feed.className = "draft-feed";

  for (const draft of drafts) {
    const card = document.createElement("article");
    card.className = `draft-card ${draft.kind} collapsed`;

    const head = document.createElement("div");
    head.className = "draft-head";

    const ICON_CHEVRON_RIGHT = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="12" height="12"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>`;
    const ICON_CHEVRON_DOWN = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="12" height="12"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>`;
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn btn-xs btn-ghost btn-square";
    toggleBtn.innerHTML = ICON_CHEVRON_RIGHT;
    toggleBtn.setAttribute("aria-label", "Expand draft");
    toggleBtn.setAttribute("aria-expanded", "false");
    head.appendChild(toggleBtn);

    const badge = document.createElement("span");
    badge.className = `draft-badge ${draft.kind}`;
    badge.textContent = draftKindLabel(draft.kind);
    head.appendChild(badge);

    const titleEl = document.createElement("div");
    titleEl.className = "draft-title";
    titleEl.textContent = draft.title;
    head.appendChild(titleEl);

    if (draft.targetUser) {
      const target = document.createElement("button");
      target.type = "button";
      target.className = "draft-target";
      target.textContent = `u/${draft.targetUser}`;
      target.title = `Scroll to u/${draft.targetUser} on the Reddit page`;
      target.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void scrollToUserInTab(draft.targetUser!);
      });
      head.appendChild(target);
    }

    const preview = document.createElement("div");
    preview.className = "draft-preview";
    preview.textContent = firstSentencePreview(draft.text, 140);

    const contentEl = document.createElement("div");
    contentEl.className = "draft-content";

    const body = document.createElement("div");
    body.className = "draft-text";
    body.textContent = draft.text;

    const actions = document.createElement("div");
    actions.className = "draft-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-xs btn-ghost";
    copyBtn.textContent = "Copy";
    copyBtn.setAttribute("aria-label", `Copy ${draftKindLabel(draft.kind)} draft`);
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void copyTextWithFeedback(copyBtn, draft.text);
    });
    actions.appendChild(copyBtn);

    if (onSave && draft.targetUser) {
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-xs btn-primary";
      saveBtn.textContent = "Save";
      saveBtn.setAttribute("aria-label", `Save draft for u/${draft.targetUser} to chat list`);
      saveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onSave(draft);
      });
      actions.appendChild(saveBtn);

      const helpBtn = document.createElement("button");
      helpBtn.type = "button";
      helpBtn.className = "btn btn-xs btn-circle btn-ghost";
      helpBtn.textContent = "?";
      helpBtn.setAttribute("aria-label", "How does Save work?");
      helpBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Toggle inline tooltip — remove if already shown
        const existing = actions.querySelector(".draft-help-tip");
        if (existing) { existing.remove(); return; }
        const tip = document.createElement("div");
        tip.className = "draft-help-tip";
        tip.textContent = "Save adds this person to Chat List. When they reply, open Chat List, find them, paste their reply, and the AI will craft a follow-up to convert them.";
        actions.appendChild(tip);
        const dismiss = (ev: MouseEvent): void => {
          if (!tip.contains(ev.target as Node) && ev.target !== helpBtn) {
            tip.remove();
            document.removeEventListener("click", dismiss);
          }
        };
        window.setTimeout(() => document.addEventListener("click", dismiss), 0);
        window.setTimeout(() => { tip.remove(); document.removeEventListener("click", dismiss); }, 6000);
      });
      actions.appendChild(helpBtn);
    }

    contentEl.appendChild(body);
    contentEl.appendChild(actions);

    if (draft.rationale) {
      const rationaleEl = document.createElement("p");
      rationaleEl.className = "draft-rationale";
      rationaleEl.textContent = draft.rationale;
      contentEl.appendChild(rationaleEl);
    }

    const setExpanded = (expanded: boolean): void => {
      card.classList.toggle("collapsed", !expanded);
      toggleBtn.innerHTML = expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT;
      toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggleBtn.setAttribute("aria-label", expanded ? "Collapse draft" : "Expand draft");
    };

    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(card.classList.contains("collapsed"));
    });

    card.appendChild(head);
    card.appendChild(preview);
    card.appendChild(contentEl);
    setExpanded(false);
    feed.appendChild(card);
  }

  const cleanRemainder = remainder.trim();
  if (cleanRemainder) {
    const note = document.createElement("div");
    note.className = "draft-remainder muted";
    note.innerHTML = renderMarkdown(cleanRemainder);
    feed.appendChild(note);
  }

  if (hasPartialFrame) {
    const pending = document.createElement("div");
    pending.className = "draft-pending muted";
    pending.textContent = "Generating more drafts...";
    feed.appendChild(pending);
  }

  bubble.appendChild(feed);
}

/**
 * Main entry: parses streaming text and renders it.
 * Returns structured data for history storage.
 */
function renderStructuredDrafts(
  bubble: HTMLElement,
  sourceText: string,
  onSave?: (draft: StructuredDraft) => void,
): { displayText: string; hasStructuredDrafts: boolean; drafts: StructuredDraft[]; remainder: string } {
  const { drafts, remainder, hasPartialFrame } = parseStructuredDrafts(sourceText);
  const hasItemToken = sourceText.includes(ITEM_OPEN) || sourceText.includes(ITEM_CLOSE);

  if (drafts.length === 0) {
    if (hasPartialFrame || hasItemToken || sourceText.trim() === "\u2026" || !sourceText.trim()) {
      renderThinkingState(bubble);
      return { displayText: "", hasStructuredDrafts: true, drafts: [], remainder: "" };
    }
    bubble.classList.remove("structured");
    bubble.innerHTML = renderMarkdown(sourceText);
    wireCopyButton(bubble, sourceText);
    return { displayText: sourceText, hasStructuredDrafts: false, drafts: [], remainder: sourceText };
  }

  const partialStart = hasPartialFrame ? remainder.lastIndexOf(ITEM_OPEN) : -1;
  const safeRemainder = hasPartialFrame && partialStart >= 0 ? remainder.slice(0, partialStart).trim() : remainder;
  renderDraftFeed(bubble, drafts, safeRemainder, hasPartialFrame, onSave);
  return {
    displayText: serializeDraftsForHistory(drafts, safeRemainder),
    hasStructuredDrafts: true,
    drafts,
    remainder: safeRemainder,
  };
}

function wireCopyButton(bubble: HTMLElement, fallbackContent: string): void {
  if (fallbackContent.trim().length < 20) return;
  if (bubble.querySelector(":scope > .copy-snippet")) return;
  bubble.classList.add("copy-host");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-snippet";
  btn.textContent = "Copy";
  btn.setAttribute("aria-label", "Copy full response");
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = fallbackContent.trim();
    if (!text) return;
    const original = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
    catch { btn.textContent = "Failed"; }
    finally { window.setTimeout(() => { btn.textContent = original; }, 1200); }
  });
  bubble.appendChild(btn);
}

// ---- Feedback helpers ----

async function loadFeedbackState(): Promise<FeedbackState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(FEEDBACK_STATE_KEY, (result) => {
      const s = result[FEEDBACK_STATE_KEY] as FeedbackState | undefined;
      resolve(s ?? { submitted: false, sessionsTried: 0 });
    });
  });
}

async function saveFeedbackState(state: FeedbackState): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [FEEDBACK_STATE_KEY]: state }, resolve);
  });
}

// ---- init ----

function init(): void {
  const chat = document.getElementById("chat") as HTMLElement;
  const input = document.getElementById("input") as HTMLTextAreaElement;
  const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
  const instructionToggleBtn = document.getElementById("instruction-toggle") as HTMLButtonElement;
  const loadBtn = document.getElementById("load") as HTMLButtonElement;
  const clearBtn = document.getElementById("clear") as HTMLButtonElement;
  const summary = document.getElementById("thread-summary") as HTMLElement;
  const goalBar = document.getElementById("goal-bar") as HTMLElement;
  const loadBar = document.getElementById("load-bar") as HTMLElement;
  const goalSelect = document.getElementById("goal-select") as HTMLSelectElement | null;
  const historyList = document.getElementById("history-list") as HTMLElement;
  const liveModeBtn = document.getElementById("live-mode") as HTMLButtonElement;
  const historyModeBtn = document.getElementById("history-mode") as HTMLButtonElement;
  const historyBackBtn = document.getElementById("history-back") as HTMLButtonElement | null;
  const composer = document.getElementById("composer") as HTMLElement;
  const includeCommentsInput = document.getElementById("include-comments") as HTMLInputElement | null;
  const commentToggle = document.getElementById("comment-toggle") as HTMLElement | null;
  const modelSelect = document.getElementById("model-select") as HTMLSelectElement | null;
  const chatlistBtn = document.getElementById("chatlist-btn") as HTMLButtonElement;
  const composerOptions = document.getElementById("composer-options") as HTMLElement;
  const feedbackOverlay = document.getElementById("feedback-overlay") as HTMLElement;
  const feedbackSendBtn = document.getElementById("feedback-send") as HTMLButtonElement;
  const feedbackLaterBtn = document.getElementById("feedback-later") as HTMLButtonElement;
  const feedbackTextarea = document.getElementById("feedback-text") as HTMLTextAreaElement;
  const moodBtns = Array.from(feedbackOverlay.querySelectorAll<HTMLButtonElement>(".mood-btn"));
  const draftsBadge = document.getElementById("drafts-badge") as HTMLButtonElement;
  const signInBtn = document.getElementById("sign-in-btn") as HTMLButtonElement;
  const authModal = document.getElementById("auth-modal") as HTMLDialogElement;
  const authModalGoogle = document.getElementById("auth-modal-google") as HTMLButtonElement;
  const draftsModal = document.getElementById("drafts-modal") as HTMLDialogElement;
  const draftsModalBuy = document.getElementById("drafts-modal-buy") as HTMLButtonElement;

  let mode: "live" | "history-list" | "history-detail" | "chatlist-list" | "chatlist-detail" = "live";
  let includeComments = true;
  let modelProvider: "claude" | "gemini" = "claude";
  let instructionActive = false;
  let selectedHistoryPostKey: string | null = null;
  let currentTrackedUser: TrackedUser | null = null;
  let selectedMood: string | null = null;
  let draftsRemaining: number | null = null;
  let signedIn = false;

  function openPricing(): void {
    chrome.tabs.create({ url: PRICING_URL });
  }

  function updateAuthUi(): void {
    signInBtn.classList.toggle("hidden", signedIn);
    draftsBadge.classList.toggle("hidden", !signedIn);
    if (signedIn && draftsRemaining !== null) {
      draftsBadge.textContent = `${draftsRemaining} draft${draftsRemaining === 1 ? "" : "s"}`;
      draftsBadge.classList.toggle("low", draftsRemaining <= 2);
    } else if (signedIn) {
      draftsBadge.textContent = "… drafts";
    }
  }

  async function refreshAccount(): Promise<void> {
    const user = await getCurrentUser();
    signedIn = !!user;
    if (!user) {
      draftsRemaining = null;
      updateAuthUi();
      return;
    }
    try {
      const me = await fetchMe();
      draftsRemaining = me.draftsRemaining;
    } catch {
      draftsRemaining = null;
    }
    updateAuthUi();
  }

  async function handleSignIn(): Promise<void> {
    try {
      signInBtn.disabled = true;
      authModalGoogle.disabled = true;
      await signInWithGoogle();
      authModal.close();
      showToast("Signed in — 10 free drafts if you're new");
      await refreshAccount();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      signInBtn.disabled = false;
      authModalGoogle.disabled = false;
    }
  }

  function requireSignedIn(): boolean {
    if (signedIn) return true;
    authModal.showModal();
    return false;
  }

  function requireDrafts(): boolean {
    if (draftsRemaining !== null && draftsRemaining <= 0) {
      draftsModal.showModal();
      return false;
    }
    return true;
  }

  signInBtn.addEventListener("click", () => { void handleSignIn(); });
  authModalGoogle.addEventListener("click", () => { void handleSignIn(); });
  draftsBadge.addEventListener("click", () => openPricing());
  draftsModalBuy.addEventListener("click", () => {
    draftsModal.close();
    openPricing();
  });

  // Refresh balance when side panel becomes visible again (e.g. after purchase)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshAccount();
  });
  void refreshAccount();

  function updateCommentToggleVisualState(): void {
    if (!commentToggle) return;
    commentToggle.classList.toggle("active", includeComments);
  }

  async function loadIncludeCommentsPreference(): Promise<void> {
    if (!includeCommentsInput) return;
    const { [INCLUDE_COMMENTS_KEY]: saved = true } = (await chrome.storage.local.get(INCLUDE_COMMENTS_KEY)) as { [INCLUDE_COMMENTS_KEY]?: boolean };
    includeComments = saved;
    includeCommentsInput.checked = includeComments;
    updateCommentToggleVisualState();
  }

  async function loadModelPreference(): Promise<void> {
    if (!modelSelect) return;
    const { [MODEL_PROVIDER_KEY]: saved = "claude" } = (await chrome.storage.local.get(MODEL_PROVIDER_KEY)) as { [MODEL_PROVIDER_KEY]?: string };
    modelProvider = saved === "gemini" ? "gemini" : "claude";
    modelSelect.value = modelProvider;
  }

  function renderLiveSummary(): void {
    if (!thread) { summary.textContent = "No thread loaded."; summary.className = "muted"; return; }
    const countMsg = `${thread.comments.length} comment${thread.comments.length !== 1 ? "s" : ""}`;
    summary.innerHTML =
      `<strong>${escapeHtml(thread.title || "(untitled)")}</strong><br>` +
      `${escapeHtml(thread.subreddit)} \u00B7 u/${escapeHtml(thread.author)} \u00B7 ${countMsg}`;
    summary.className = "thread-loaded";
  }

  /** Add a single bubble. For assistant turns use renderTurn instead when replaying history. */
  function addBubble(role: "user" | "assistant", content = ""): HTMLElement {
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    if (role === "assistant") {
      renderStructuredDrafts(el, content);
    } else {
      el.textContent = content;
    }
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  /** Replay a saved turn faithfully using stored structured drafts if available. */
  function renderTurn(turn: ConversationTurn): void {
    // Skip auto-generated user turns that have no visible instruction
    if (turn.hidden) return;

    const el = document.createElement("div");
    el.className = `bubble ${turn.role}`;

    if (turn.role === "user") {
      el.textContent = turn.content;
    } else if (turn.structuredDrafts && turn.structuredDrafts.length > 0) {
      // Use saved structured drafts directly — same card UI as live chat
      renderDraftFeed(el, turn.structuredDrafts, turn.structuredRemainder || "", false);
    } else {
      // Fallback: re-parse content (handles old saved chats without structuredDrafts)
      renderStructuredDrafts(el, turn.content || "");
    }

    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function renderTranscript(turns: ConversationTurn[]): void {
    chat.innerHTML = "";
    for (const turn of turns) renderTurn(turn);
  }

  function setMode(next: "live" | "history-list" | "history-detail" | "chatlist-list" | "chatlist-detail"): void {
    mode = next;
    const isLive = next === "live";
    const isHistoryDetail = next === "history-detail";
    const isChatListDetail = next === "chatlist-detail";
    const isChatListList = next === "chatlist-list";
    const isAnyHistory = next === "history-list" || isHistoryDetail;
    const showBackBtn = isHistoryDetail || isChatListDetail;
    const isListView = next === "history-list" || isChatListList;

    liveModeBtn.classList.toggle("active", isLive);
    historyModeBtn.classList.toggle("active", isAnyHistory);
    chatlistBtn.classList.toggle("active", isChatListDetail || isChatListList);
    liveModeBtn.setAttribute("aria-selected", String(isLive));
    historyModeBtn.setAttribute("aria-selected", String(isAnyHistory));

    historyList.classList.add("hidden");
    composer.classList.toggle("hidden", !isLive && !isChatListDetail);
    goalBar.classList.toggle("hidden", !isLive);
    loadBar.classList.toggle("hidden", !isLive);
    summary.classList.toggle("hidden", !isLive);
    loadBtn.disabled = !isLive;
    clearBtn.disabled = !isLive;
    goalSelect?.toggleAttribute("disabled", !isLive);
    includeCommentsInput?.toggleAttribute("disabled", !isLive);
    modelSelect?.toggleAttribute("disabled", !isLive);
    historyBackBtn?.classList.toggle("hidden", !showBackBtn);
    chat.classList.toggle("history-list-view", isListView);

    composerOptions.classList.toggle("hidden", isChatListDetail);
    if (isChatListDetail) {
      input.classList.remove("hidden");
      input.placeholder = "What did they reply? Paste their message or describe\u2026";
      generateBtn.textContent = "Send";
      generateBtn.disabled = false;
    } else {
      input.classList.toggle("hidden", !instructionActive);
      input.placeholder = "e.g. DMs only \u00B7 focus on u/someuser \u00B7 skip OP";
      generateBtn.textContent = "Generate";
      generateBtn.disabled = !isLive;
    }

    if (isLive) {
      renderLiveSummary();
      if (history.length === 0) {
        chat.innerHTML = "";
        if (!hasLoaded) renderOnboarding();
      } else {
        renderTranscript(history);
      }
    }
  }

  function renderOnboarding(): void {
    const card = document.createElement("div");
    card.className = "onboarding-card";
    card.innerHTML =
      `<p class="onboarding-title">Get started</p>` +
      `<ol class="onboarding-steps">` +
      `<li><strong>Sign in with Google</strong> &mdash; new accounts get 10 free drafts.</li>` +
      `<li><strong>Open a Reddit post</strong> where your target users are active, then click <strong>Load thread from page</strong> above.</li>` +
      `<li><strong>Select a goal &amp; hit Generate</strong> &mdash; get tailored replies, comments, or DMs.</li>` +
      `<li><strong>Pick the best draft.</strong> For DMs, click <strong>Save</strong> &mdash; if they reply, open <strong>Chat List</strong> to continue with full thread context.</li>` +
      `</ol>`;
    chat.appendChild(card);
  }

  async function renderHistoryList(): Promise<void> {
    const map = await getSavedConversationMap();
    const entries = Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
    chat.innerHTML = "";

    const page = document.createElement("div");
    page.className = "history-page";

    const heading = document.createElement("div");
    heading.className = "history-page-title";
    heading.textContent = "Saved chats";
    page.appendChild(heading);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-history";
      empty.textContent = "No saved chats yet. Send at least one message in Live chat.";
      page.appendChild(empty);
      chat.appendChild(page);
      return;
    }

    const clearAllBtn = document.createElement("button");
    clearAllBtn.className = "btn btn-xs btn-ghost";
    clearAllBtn.type = "button";
    clearAllBtn.textContent = "Clear all";
    clearAllBtn.addEventListener("click", async () => {
      if (!window.confirm("Delete all saved chats permanently?")) return;
      await setSavedConversationMap({});
      selectedHistoryPostKey = null;
      await renderHistoryList();
    });
    heading.appendChild(clearAllBtn);

    const list = document.createElement("div");
    list.className = "history-page-list";

    for (const item of entries) {
      const row = document.createElement("div");
      row.className = "history-row";

      const openBtn = document.createElement("button");
      openBtn.className = "history-chat-item";

      const dt = new Date(item.updatedAt);
      const dateLabel = `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

      openBtn.innerHTML =
        `<span class="title">${escapeHtml(item.title || "(untitled)")}</span>` +
        `<span class="meta">${escapeHtml(item.subreddit)} \u00B7 ${item.turns.length} messages \u00B7 ${escapeHtml(dateLabel)}</span>`;

      openBtn.addEventListener("click", () => {
        selectedHistoryPostKey = item.postKey;
        conversationSummary = item.summary || "";
        threadSummary = item.threadSummary || "";
        setMode("history-detail");
        renderTranscript((item.turns || []) as ConversationTurn[]);
      });

      const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>`;
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn btn-sm btn-ghost btn-square btn-error";
      deleteBtn.type = "button";
      deleteBtn.innerHTML = ICON_TRASH;
      deleteBtn.title = "Delete saved chat";
      deleteBtn.setAttribute("aria-label", "Delete saved chat");
      deleteBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!window.confirm("Delete this saved chat permanently?")) return;
        const nextMap = await getSavedConversationMap();
        if (!nextMap[item.postKey]) return;
        delete nextMap[item.postKey];
        await setSavedConversationMap(nextMap);
        if (selectedHistoryPostKey === item.postKey) { selectedHistoryPostKey = null; setMode("history-list"); }
        await renderHistoryList();
      });

      row.appendChild(openBtn);
      row.appendChild(deleteBtn);
      list.appendChild(row);
    }

    page.appendChild(list);
    chat.appendChild(page);
    chat.scrollTop = 0;
  }

  async function renderChatList(): Promise<void> {
    const users = await getTrackedUsers();
    chat.innerHTML = "";

    const page = document.createElement("div");
    page.className = "history-page";

    const heading = document.createElement("div");
    heading.className = "history-page-title";
    heading.textContent = "Chat List";
    page.appendChild(heading);

    if (users.length > TRACKED_USERS_WARN_THRESHOLD) {
      const warn = document.createElement("div");
      warn.className = "chatlist-warning";
      warn.textContent = `\u26A0\uFE0F ${users.length} contacts saved \u2014 getting large. Delete old ones who never replied to keep storage lean.`;
      page.appendChild(warn);
    }

    if (users.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-history";
      empty.textContent = "No saved contacts yet. Click \u201CSave\u201D on a draft card to track someone you outreached.";
      page.appendChild(empty);
      chat.appendChild(page);
      return;
    }

    const clearAllBtn = document.createElement("button");
    clearAllBtn.className = "btn btn-xs btn-ghost";
    clearAllBtn.type = "button";
    clearAllBtn.textContent = "Clear all";
    clearAllBtn.addEventListener("click", async () => {
      if (!window.confirm("Remove all contacts from chat list permanently?")) return;
      await setTrackedUsers([]);
      currentTrackedUser = null;
      await renderChatList();
    });
    heading.appendChild(clearAllBtn);

    const list = document.createElement("div");
    list.className = "history-page-list";

    for (const user of users) {
      const row = document.createElement("div");
      row.className = "history-row";

      const openBtn = document.createElement("button");
      openBtn.className = "history-chat-item";

      const dt = new Date(user.savedAt);
      const dateLabel = `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const followUpCount = Math.floor(user.followUpTurns.length / 2);

      openBtn.innerHTML =
        `<span class="title">u/${escapeHtml(user.username)}</span>` +
        `<span class="meta chatlist-meta">` +
        `<span class="draft-badge ${user.kind}">${draftKindLabel(user.kind)}</span> ` +
        `${escapeHtml(truncate(user.postTitle, 50))} \u00B7 ${escapeHtml(dateLabel)}` +
        (followUpCount > 0 ? ` \u00B7 ${followUpCount} follow-up${followUpCount !== 1 ? "s" : ""}` : "") +
        `</span>`;

      openBtn.addEventListener("click", () => { renderChatListDetail(user); });

      const ICON_TRASH_CHAT = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>`;
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn btn-sm btn-ghost btn-square btn-error";
      deleteBtn.type = "button";
      deleteBtn.innerHTML = ICON_TRASH_CHAT;
      deleteBtn.title = "Remove from chat list";
      deleteBtn.setAttribute("aria-label", "Remove from chat list");
      deleteBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!window.confirm(`Remove u/${user.username} from chat list?`)) return;
        const next = await getTrackedUsers();
        await setTrackedUsers(next.filter((u) => u.id !== user.id));
        if (currentTrackedUser?.id === user.id) currentTrackedUser = null;
        await renderChatList();
      });

      row.appendChild(openBtn);
      row.appendChild(deleteBtn);
      list.appendChild(row);
    }

    page.appendChild(list);
    chat.appendChild(page);
    chat.scrollTop = 0;
  }

  function renderChatListDetail(user: TrackedUser): void {
    currentTrackedUser = user;
    chat.innerHTML = "";

    const ctx = document.createElement("div");
    ctx.className = "chatlist-context-card";

    const ctxHeader = document.createElement("div");
    ctxHeader.className = "chatlist-context-header";
    const kindBadge = document.createElement("span");
    kindBadge.className = `draft-badge ${user.kind}`;
    kindBadge.textContent = draftKindLabel(user.kind);
    ctxHeader.appendChild(kindBadge);
    ctxHeader.appendChild(document.createTextNode(` to `));
    const uname = document.createElement("strong");
    uname.textContent = `u/${user.username}`;
    ctxHeader.appendChild(uname);
    ctxHeader.appendChild(document.createTextNode(` \u00B7 `));
    const sub = document.createElement("span");
    sub.className = "muted";
    sub.textContent = user.subreddit;
    ctxHeader.appendChild(sub);
    ctx.appendChild(ctxHeader);

    const origLabel = document.createElement("div");
    origLabel.className = "chatlist-orig-label";
    origLabel.textContent = "Your outreach:";
    ctx.appendChild(origLabel);

    const orig = document.createElement("div");
    orig.className = "chatlist-original-draft";
    orig.textContent = user.originalDraft;
    ctx.appendChild(orig);

    const details = document.createElement("details");
    details.className = "chatlist-thread-summary";
    const summary2 = document.createElement("summary");
    summary2.textContent = "Thread context";
    const pre = document.createElement("pre");
    pre.textContent = user.threadSummary || "(no thread context saved)";
    details.appendChild(summary2);
    details.appendChild(pre);
    ctx.appendChild(details);

    chat.appendChild(ctx);

    for (const turn of user.followUpTurns) {
      const el = document.createElement("div");
      el.className = `bubble ${turn.role}`;
      if (turn.role === "user") {
        el.textContent = turn.content;
      } else {
        renderStructuredDrafts(el, turn.content || "");
      }
      chat.appendChild(el);
    }

    chat.scrollTop = chat.scrollHeight;
    setMode("chatlist-detail");
  }

  async function sendFollowUp(): Promise<void> {
    if (!currentTrackedUser) return;
    if (generateBtn.disabled) return;
    if (!requireSignedIn()) return;
    if (!requireDrafts()) return;
    const userMsg = input.value.trim();
    if (!userMsg) {
      showToast("Describe what they replied before sending.");
      return;
    }

    const goal: Goal | null = currentTrackedUser.goalName
      ? { id: "", name: currentTrackedUser.goalName, description: currentTrackedUser.goalDescription }
      : null;

    const system = buildConversionSystemPrompt(
      currentTrackedUser.username,
      currentTrackedUser.kind,
      currentTrackedUser.subreddit,
      currentTrackedUser.originalDraft,
      currentTrackedUser.threadSummary,
      goal,
    );

    addBubble("user", userMsg);
    input.value = "";

    const userTurn: ChatTurn = { role: "user", content: userMsg };
    currentTrackedUser.followUpTurns.push(userTurn);
    const out = addBubble("assistant", "\u2026");
    generateBtn.disabled = true;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

    try {
      const stream = streamGenerate(
        { system, history: currentTrackedUser.followUpTurns },
        controller.signal,
      );

      let acc = "";
      for await (const delta of stream) {
        acc += delta;
        renderStructuredDrafts(out, acc || "\u2026");
        chat.scrollTop = chat.scrollHeight;
      }
      const rendered = renderStructuredDrafts(out, acc || "");
      const finalText = rendered.displayText || acc;
      currentTrackedUser.followUpTurns.push({ role: "assistant", content: finalText });

      const users = await getTrackedUsers();
      const idx = users.findIndex((u) => u.id === currentTrackedUser!.id);
      if (idx >= 0) { users[idx] = currentTrackedUser; await setTrackedUsers(users); }
      await refreshAccount();
    } catch (e) {
      if (e instanceof ApiError && e.code === "insufficient_drafts") {
        draftsRemaining = 0;
        updateAuthUi();
        draftsModal.showModal();
        out.textContent = "No drafts left. Buy more to continue.";
      } else if (e instanceof Error && e.name === "AbortError") {
        out.textContent = "Request timed out — something went wrong. Try again or refresh the page.";
      } else {
        out.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    } finally {
      window.clearTimeout(timeoutId);
      generateBtn.disabled = false;
    }
  }

  async function loadGoals(): Promise<void> {
    if (!goalSelect) return;
    const { goals = [], activeGoalId = null } = (await chrome.storage.local.get(["goals", "activeGoalId"])) as { goals?: Goal[]; activeGoalId?: string | null };
    goalSelect.innerHTML = '<option value="">No goal</option>';
    for (const g of goals) {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      goalSelect.appendChild(opt);
    }
    goalSelect.value = activeGoalId ?? "";
    activeGoal = activeGoalId ? (goals.find((g) => g.id === activeGoalId) ?? null) : null;
  }

  document.getElementById("settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("manage-goals")?.addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("goals.html") })
  );

  goalSelect?.addEventListener("change", async () => {
    const { goals = [] } = (await chrome.storage.local.get("goals")) as { goals?: Goal[] };
    const id = goalSelect.value;
    activeGoal = id ? (goals.find((g) => g.id === id) ?? null) : null;
    await chrome.storage.local.set({ activeGoalId: id || null });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.goals || changes.activeGoalId) void loadGoals();
    if (changes[CHAT_HISTORY_KEY] && mode === "history-list") void renderHistoryList();
    if (changes[TRACKED_USERS_KEY] && mode === "chatlist-list") void renderChatList();
    if (changes[INCLUDE_COMMENTS_KEY]) {
      includeComments = Boolean(changes[INCLUDE_COMMENTS_KEY].newValue);
      if (includeCommentsInput) includeCommentsInput.checked = includeComments;
      updateCommentToggleVisualState();
    }
  });

  includeCommentsInput?.addEventListener("change", async () => {
    includeComments = includeCommentsInput.checked;
    updateCommentToggleVisualState();
    await chrome.storage.local.set({ [INCLUDE_COMMENTS_KEY]: includeComments });
  });

  modelSelect?.addEventListener("change", async () => {
    modelProvider = modelSelect.value === "gemini" ? "gemini" : "claude";
    await chrome.storage.local.set({ [MODEL_PROVIDER_KEY]: modelProvider });
  });

  liveModeBtn.addEventListener("click", () => setMode("live"));
  historyModeBtn.addEventListener("click", async () => { setMode("history-list"); await renderHistoryList(); });
  historyBackBtn?.addEventListener("click", async () => {
    if (mode === "chatlist-detail") { setMode("chatlist-list"); await renderChatList(); }
    else { setMode("history-list"); await renderHistoryList(); }
  });
  chatlistBtn.addEventListener("click", async () => { setMode("chatlist-list"); await renderChatList(); });

  async function doLoad(): Promise<void> {
    const btnLabel = hasLoaded ? "Reload thread" : "Load thread from page";
    loadBtn.textContent = "Loading\u2026";
    loadBtn.disabled = true;
    summary.textContent = "Loading\u2026";
    summary.className = "muted";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/reddit\.com/.test(tab.url ?? "")) {
      summary.textContent = "Open a Reddit post tab, then try again.";
      loadBtn.textContent = btnLabel;
      loadBtn.disabled = false;
      return;
    }

    try {
      const resp = await trySendMessage(tab.id);

      if (!resp) {
        summary.textContent = "Couldn\u2019t reach the page \u2014 refresh the Reddit tab (Ctrl+R) and try again.";
        loadBtn.textContent = btnLabel;
        loadBtn.disabled = false;
        return;
      }
      if (!resp.ok) {
        summary.textContent = `Couldn\'t read thread: ${resp.error}`;
        loadBtn.textContent = btnLabel;
        loadBtn.disabled = false;
        return;
      }

      thread = resp.thread;
      history.length = 0;
      chat.innerHTML = "";
      conversationSummary = "";
      threadSummary = "";
      selectedHistoryPostKey = null;

      const { meta } = resp;
      let countMsg = `${thread.comments.length} comment${thread.comments.length !== 1 ? "s" : ""}`;
      if (meta.hasMore) countMsg += " (more available on page)";

      summary.innerHTML =
        `<strong>${escapeHtml(thread.title || "(untitled)")}</strong><br>` +
        `${escapeHtml(thread.subreddit)} \u00B7 u/${escapeHtml(thread.author)} \u00B7 ${countMsg}`;

      if (thread.comments.length === 0) {
        summary.innerHTML += `<br><span class="warn">No comments captured \u2014 scroll down on the Reddit tab to load comments, then reload.</span>`;
      } else if (meta.partialLoad) {
        summary.innerHTML += `<br><span class="warn">Some comments may not have loaded yet. Reload to retry.</span>`;
      }

      summary.className = "thread-loaded";
      hasLoaded = true;
      loadBtn.textContent = "Reload thread";
      setMode("live");
    } catch (e) {
      summary.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      loadBtn.textContent = btnLabel;
    }
    loadBtn.disabled = false;
  }

  loadBtn.addEventListener("click", () => { void doLoad(); });

  clearBtn.addEventListener("click", () => {
    history.length = 0;
    thread = null;
    conversationSummary = "";
    threadSummary = "";
    hasLoaded = false;
    chat.innerHTML = "";
    summary.textContent = "No thread loaded.";
    summary.className = "muted";
    loadBtn.textContent = "Load thread from page";
  });

  async function send(): Promise<void> {
    if (generateBtn.disabled) return;
    if (!requireSignedIn()) return;
    if (!requireDrafts()) return;

    if (!activeGoal) {
      showToast("Select a goal first — click the goal dropdown to choose one.");
      return;
    }
    if (!thread) {
      addBubble("assistant", "Load a Reddit thread first by clicking **Load thread from page**.");
      return;
    }

    // Instruction is only active when the toggle is on
    const instruction = instructionActive ? input.value.trim() : "";
    // The API always needs a non-empty user message; use instruction → goal
    const apiMessage = instruction
      || `${activeGoal.name}: ${activeGoal.description}`;

    // Show instruction bubble only when the user actually typed something
    if (instruction) addBubble("user", instruction);

    history.push({ role: "user", content: apiMessage, hidden: !instruction });

    const out = addBubble("assistant", "\u2026");
    generateBtn.disabled = true;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

    try {
      const firstThreadCall = !threadSummary.trim();
      const system = buildSystemPrompt(thread, activeGoal, apiMessage, {
        summary: firstThreadCall ? conversationSummary : threadSummary,
        includeRawThread: firstThreadCall,
        requestThreadSummary: firstThreadCall,
        includeComments,
      });

      // Hosted path: client still builds system prompt (keeps summarization logic local)
      const stream = streamGenerate({
        system,
        history: history.map((t) => ({ role: t.role, content: t.content })),
      }, controller.signal);

      let acc = "";
      for await (const delta of stream) {
        acc += delta;
        const { visibleText } = parseThreadSummaryBlock(acc);
        renderStructuredDrafts(out, visibleText || "\u2026");
        chat.scrollTop = chat.scrollHeight;
      }

      const { visibleText, extractedSummary } = parseThreadSummaryBlock(acc);
      const onSave = (draft: StructuredDraft): void => {
        if (!draft.targetUser) return;
        void saveTrackedUser({
          id: crypto.randomUUID(),
          savedAt: Date.now(),
          username: draft.targetUser,
          kind: draft.kind,
          originalDraft: draft.text,
          postTitle: thread?.title ?? "(untitled)",
          postUrl: thread?.url ?? "",
          subreddit: thread?.subreddit ?? "?",
          threadSummary: threadSummary || fallbackThreadSummary(thread!),
          goalName: activeGoal?.name ?? "",
          goalDescription: activeGoal?.description ?? "",
          followUpTurns: [],
        });
      };
      const rendered = renderStructuredDrafts(out, visibleText || acc, onSave);
      const finalText = rendered.displayText || visibleText || acc;

      if (firstThreadCall) {
        threadSummary = truncate(extractedSummary || fallbackThreadSummary(thread), MAX_SUMMARY_CHARS);
      }

      // Save structured drafts with the turn so history can replay exact card UI
      history.push({
        role: "assistant",
        content: finalText,
        structuredDrafts: rendered.drafts.length ? rendered.drafts : undefined,
        structuredRemainder: rendered.remainder || undefined,
      });

      truncateConversationSummary(apiMessage, finalText);
      await saveCurrentConversation();
      await refreshAccount();
      void maybeShowFeedbackModal();
    } catch (e) {
      // Roll back the optimistic user turn if generation failed before assistant reply
      if (history.length && history[history.length - 1]?.role === "user") {
        history.pop();
      }
      if (e instanceof ApiError && e.code === "insufficient_drafts") {
        draftsRemaining = 0;
        updateAuthUi();
        draftsModal.showModal();
        out.textContent = "No drafts left. Buy more to continue.";
      } else if (e instanceof Error && e.name === "AbortError") {
        out.textContent = "Request timed out — something went wrong. Try again or refresh the page.";
      } else {
        out.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    } finally {
      window.clearTimeout(timeoutId);
      generateBtn.disabled = false;
    }
  }

  instructionToggleBtn.addEventListener("click", () => {
    instructionActive = !instructionActive;
    instructionToggleBtn.classList.toggle("active", instructionActive);
    instructionToggleBtn.textContent = instructionActive ? "− Remove instruction" : "+ Instruction";
    input.classList.toggle("hidden", !instructionActive);
    if (instructionActive) {
      input.focus();
    } else {
      input.value = "";
    }
  });

  generateBtn.addEventListener("click", () => {
    if (mode === "chatlist-detail") { void sendFollowUp(); }
    else { void send(); }
  });
  input.addEventListener("keydown", (e) => {
    if (generateBtn.disabled) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (mode === "chatlist-detail") { void sendFollowUp(); }
      else { void send(); }
    }
  });

  // ---- Feedback modal wiring ----

  for (const btn of moodBtns) {
    btn.addEventListener("click", () => {
      for (const b of moodBtns) b.classList.remove("selected");
      btn.classList.add("selected");
      selectedMood = btn.dataset.mood ?? null;
      feedbackSendBtn.disabled = !selectedMood;
    });
  }

  feedbackSendBtn.addEventListener("click", () => {
    if (!selectedMood) return;
    const message = feedbackTextarea.value.trim();
    feedbackOverlay.classList.add("hidden");
    const content = `📬 **Feedback — Reddit Reply Assistant**\n**Mood:** ${selectedMood}${message ? `\n**Note:** ${message}` : ""}`;
    void fetch(FEEDBACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch(() => { /* silently ignore network errors */ });
    void saveFeedbackState({ submitted: true, sessionsTried: MAX_FEEDBACK_SESSIONS });
  });

  feedbackLaterBtn.addEventListener("click", () => {
    feedbackOverlay.classList.add("hidden");
    void loadFeedbackState().then((state) =>
      saveFeedbackState({ ...state, sessionsTried: state.sessionsTried + 1 }),
    );
  });

  async function maybeShowFeedbackModal(): Promise<void> {
    if (shownFeedbackThisSession) return;
    const state = await loadFeedbackState();
    if (state.submitted || state.sessionsTried >= MAX_FEEDBACK_SESSIONS) return;
    shownFeedbackThisSession = true;
    selectedMood = null;
    feedbackSendBtn.disabled = true;
    for (const b of moodBtns) b.classList.remove("selected");
    feedbackTextarea.value = "";
    feedbackOverlay.classList.remove("hidden");
  }

  void loadIncludeCommentsPreference();
  void loadModelPreference();
  void loadGoals();
  void renderHistoryList();
  setMode("live");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
