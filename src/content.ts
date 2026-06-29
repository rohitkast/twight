// Runs on reddit.com pages. Extracts the post + comments from the DOM on request.
import type {
  RedditThread,
  RedditComment,
  ExtractRequest,
  ExtractResponse,
  ExtractMeta,
} from "./lib/types";

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// Clone the node and strip out nested shreddit-comments before reading text,
// so depth-0 body text doesn't include reply text even if they share a subtree.
function bodyFromShredditComment(node: Element): string {
  for (const slotName of ["comment", "text-body"]) {
    const el = node.querySelector(`:scope > [slot="${slotName}"]`);
    if (el) {
      const clone = el.cloneNode(true) as Element;
      clone.querySelectorAll("shreddit-comment").forEach((n) => n.remove());
      const t = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
  }
  // Last resort: clone whole node, strip nested comments
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll("shreddit-comment").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

// Wait until shreddit-comment elements appear AND at least one has readable body.
// Handles SPA navigation lag (content script is loaded once per tab, not per nav).
async function waitForShredditComments(maxMs = 2500): Promise<Element[]> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const nodes = Array.from(document.querySelectorAll("shreddit-comment"));
    if (nodes.length > 0 && nodes.some((n) => bodyFromShredditComment(n).length > 0)) {
      return nodes;
    }
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  // Return whatever exists even if bodies are still empty
  return Array.from(document.querySelectorAll("shreddit-comment"));
}

function extractPost(): Pick<RedditThread, "subreddit" | "title" | "author" | "body"> {
  const post = document.querySelector("shreddit-post");
  if (post) {
    return {
      title: post.getAttribute("post-title") ?? text(post.querySelector("[slot='title']")),
      author: post.getAttribute("author") ?? "",
      subreddit: post.getAttribute("subreddit-prefixed-name") ?? "",
      body: text(post.querySelector("[slot='text-body']")),
    };
  }
  // Old Reddit fallback
  return {
    title: text(document.querySelector("h1")),
    author: text(document.querySelector(".top-matter .author")),
    subreddit: text(document.querySelector(".top-matter .subreddit")),
    body: text(document.querySelector(".usertext-body .md")),
  };
}

async function extractThread(): Promise<{ thread: RedditThread; meta: ExtractMeta }> {
  const postData = extractPost();

  // --- New Reddit (shreddit web components) ---
  const shredditNodes = await waitForShredditComments();

  if (shredditNodes.length > 0) {
    const comments: RedditComment[] = [];
    for (const node of shredditNodes) {
      const author = node.getAttribute("author") || "[deleted]";
      const depth = Number(node.getAttribute("depth") ?? "0");
      const score = node.getAttribute("score") ?? undefined;
      const body = bodyFromShredditComment(node);
      if (body) comments.push({ author, depth, body, score });
    }

    const hasMore = !!document.querySelector(
      'button[aria-label*="more replies"], .morecomments a, faceplate-partial[loading]',
    );
    const partialLoad = comments.length < shredditNodes.length;

    return {
      thread: { url: location.href, ...postData, comments },
      meta: { strategy: "shreddit", total: shredditNodes.length, partialLoad, hasMore },
    };
  }

  // --- Old Reddit fallback ---
  const oldNodes = Array.from(document.querySelectorAll(".thing.comment"));
  if (oldNodes.length > 0) {
    const comments: RedditComment[] = [];
    for (const node of oldNodes) {
      const body = text(node.querySelector(":scope > .entry .usertext-body .md"));
      if (!body) continue;
      comments.push({
        author: node.getAttribute("data-author") || "[deleted]",
        depth: Number(node.getAttribute("data-depth") ?? "0"),
        score: text(node.querySelector(":scope > .entry .score")) || undefined,
        body,
      });
    }

    const hasMore = !!document.querySelector(".morecomments");

    return {
      thread: { url: location.href, ...postData, comments },
      meta: { strategy: "old-reddit", total: oldNodes.length, partialLoad: false, hasMore },
    };
  }

  return {
    thread: { url: location.href, ...postData, comments: [] },
    meta: { strategy: "none", total: 0, partialLoad: true, hasMore: false },
  };
}

chrome.runtime.onMessage.addListener(
  (msg: ExtractRequest, _sender, sendResponse: (r: ExtractResponse) => void) => {
    if (msg?.type === "EXTRACT_THREAD") {
      extractThread()
        .then(({ thread, meta }) => sendResponse({ ok: true, thread, meta }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // keep channel open for async response
    }
    return false;
  },
);
