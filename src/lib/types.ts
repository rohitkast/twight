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

export type ExtractRequest = { type: "EXTRACT_THREAD" };

export type ExtractResponse =
  | { ok: true; thread: RedditThread; meta: ExtractMeta }
  | { ok: false; error: string };
