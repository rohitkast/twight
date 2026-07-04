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
  description: string;
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

export type ScrollToUserResponse =
  | { ok: true }
  | { ok: false; error: "not_reddit" | "user_not_found" };

export type ExtractResponse =
  | { ok: true; thread: RedditThread; meta: ExtractMeta }
  | { ok: false; error: string };
