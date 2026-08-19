// Shared types for messaging between the content script and the side panel.

export interface RedditComment {
  author: string;
  body: string;
  depth: number;
  score?: string;
}

export interface RedditThread {
  url: string;
  subreddit: string;
  title: string;
  author: string;
  body: string;
  comments: RedditComment[];
}

export interface Goal {
  id: string;
  name: string;
  /** List preview / legacy freeform. Prefer product + intent when present. */
  description: string;
  /** What the user is offering (product or service). */
  product?: string;
  /** What they want drafts to achieve. */
  intent?: string;
  /** Optional: what to avoid in outreach. */
  avoid?: string;
  /** AI-generated outreach playbook — used for draft generation. */
  playbook?: string;
  /** Suggested ICP labels (chips). */
  targetTypes?: string[];
  playbookGeneratedAt?: number;
}

/** True when the goal has a usable AI playbook. */
export function goalHasPlaybook(goal: Goal | null | undefined): boolean {
  return !!goal?.playbook?.trim();
}

/** Goals without a playbook must be upgraded before use. */
export function goalNeedsUpgrade(goal: Goal | null | undefined): boolean {
  return !!goal && !goalHasPlaybook(goal);
}

export interface ExtractMeta {
  strategy: "shreddit" | "old-reddit" | "none";
  total: number;
  partialLoad: boolean;
  hasMore: boolean;
}

export type ExtractRequest =
  | { type: "EXTRACT_THREAD" }
  | { type: "SCROLL_TO_USER"; username: string };

/** Content script → service worker (user gesture: open panel + load this tab's thread). */
export type OpenSidePanelRequest = { type: "OPEN_SIDE_PANEL" };

export const PENDING_THREAD_LOAD_KEY = "pendingThreadLoad";

export interface PendingThreadLoad {
  tabId: number;
  at: number;
}

export type ScrollToUserResponse =
  | { ok: true }
  | { ok: false; error: "not_reddit" | "user_not_found" };

export type ExtractResponse =
  | { ok: true; thread: RedditThread; meta: ExtractMeta }
  | { ok: false; error: string };
