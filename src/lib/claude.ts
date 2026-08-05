import Anthropic from "@anthropic-ai/sdk";
import type { RedditThread, Goal } from "./types";
import { goalHasPlaybook } from "./types";

/** Format goal section for system prompts — prefer playbook + chips over raw description. */
const MAX_PLAYBOOK_CHARS = 2800;

export function formatGoalSection(goal: Goal | null): string | null {
  if (!goal) return null;
  if (goalHasPlaybook(goal)) {
    let playbook = goal.playbook!.trim();
    if (playbook.length > MAX_PLAYBOOK_CHARS) {
      playbook = playbook.slice(0, MAX_PLAYBOOK_CHARS) + "…";
    }
    const parts = [`# Goal\n${goal.name}`, "", playbook];
    if (goal.targetTypes?.length) {
      parts.push(
        "",
        "# Target types (prefer these; skip weak fits)",
        ...goal.targetTypes.map((t) => `- ${t}`),
      );
    }
    return parts.join("\n");
  }
  return `# Goal\n${goal.name}: ${goal.description}`;
}

/** Keywords for comment ranking when the user has no custom instruction. */
export function goalRankingText(goal: Goal): string {
  const bits = [
    goal.name,
    goal.product,
    goal.intent,
    ...(goal.targetTypes ?? []),
    !goal.product && !goal.intent ? goal.description : "",
  ].filter((s) => !!s?.trim());
  return bits.join(" — ");
}

export const MODEL = "claude-sonnet-4-5";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface PromptContext {
  summary?: string;
  includeRawThread?: boolean;
  requestThreadSummary?: boolean;
  includeComments?: boolean;
}

export function getClient(apiKey: string): Anthropic {
  // dangerouslyAllowBrowser is required to call the API from a browser/extension
  // context. Safe here because the key is the user's own, stored only in this browser.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// Input token budget: truncate aggressively to keep prompt small across turns.
const MAX_COMMENT_CHARS = 300;
const MAX_COMMENTS = 16;
const MAX_HISTORY_TURNS = 6; // 3 exchanges kept in each API call
const MAX_SUMMARY_CHARS = 1200;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "have",
  "what",
  "your",
  "just",
  "they",
  "them",
  "into",
  "about",
  "would",
  "there",
  "could",
  "should",
  "where",
  "when",
  "which",
  "also",
  "been",
  "were",
  "will",
  "some",
  "than",
  "then",
  "their",
  "need",
  "want",
  "like",
  "make",
  "help",
]);

const BASE_SYSTEM = `You help craft tailored Reddit replies and DMs.
Given a Reddit thread:
- Match the subreddit's tone. Sound human, never like marketing copy or AI.
- You can intentionally not use capital letters, use ... instead of big dashes, be natural like a human.
- Try to be consice most of the times unless a big explanation is necessary or a user is asking to explain details      regarding the product/service.
- Ground DMs in what the specific user actually wrote in the thread.
- Prefer people who match the goal's target types. Skip weak fits (milestone posters with no relevant signal, competitors, wrong channel).
- Never invent facts or channels (e.g. do not assume they use Reddit unless they said so). Prefer a public comment over a cold DM on celebration/milestone posts.
- Helps first, pitch second. Soft, specific CTA — avoid vague "would love your thoughts if you ever…".
- Give the draft directly. Ask one clarifying question only if truly ambiguous.
- Never invent facts beyond what is provided.
- Comments may be truncated for brevity. Never mention or allude to truncation, missing text, or incomplete comments in any draft.`;

function appendOutputContract(parts: string[], requestThreadSummary: boolean, maxItems = 6): void {
  const capped = Math.max(1, Math.min(6, maxItems));
  parts.push(
    "",
    "Output contract:",
    `Emit each draft in its own frame using ${"<ITEM>"}JSON${"</ITEM>"}.`,
    "JSON fields: kind (dm|reply|comment), targetUser (string or null), title, text, rationale.",
    `Emit 1-${capped} items (prefer fewer, complete frames over many truncated ones). No markdown code fences.`,
    "Finish every ITEM frame — never leave JSON unclosed.",
  );

  if (requestThreadSummary) {
    parts.push(
      "",
      "After all ITEM frames, append a concise thread summary for future turns in this exact format:",
      "<THREAD_SUMMARY>",
      "2-6 bullet points capturing core problem, key commenters, objections, and best outreach angle.",
      "</THREAD_SUMMARY>",
      "Keep this summary under 900 characters.",
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function keywordSet(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w));
  return new Set(words);
}

function scoreCommentForQuery(body: string, queryWords: Set<string>): number {
  if (!queryWords.size) return 0;
  const bodyWords = keywordSet(body);
  let overlap = 0;
  for (const w of queryWords) {
    if (bodyWords.has(w)) overlap += 1;
  }
  return overlap;
}

export function buildSystemPrompt(
  thread: RedditThread | null,
  goal: Goal | null = null,
  latestUserMessage = "",
  context: PromptContext = {},
): string {
  const {
    summary = "",
    includeRawThread = true,
    requestThreadSummary = false,
    includeComments = true,
  } = context;

  const goalSection = formatGoalSection(goal);
  const maxItems = goalHasPlaybook(goal) ? 3 : 6;

  if (!thread && !summary.trim()) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push('\nNo thread loaded. Ask the user to click "Load thread from page".');
    appendOutputContract(parts, requestThreadSummary, maxItems);
    return parts.join("\n");
  }

  if (!includeRawThread && summary.trim()) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push(
      "",
      "# Thread summary",
      truncate(summary.trim(), MAX_SUMMARY_CHARS),
      "",
      "Use only this summary as thread context. Do not ask for raw post/comments unless essential.",
    );
    appendOutputContract(parts, requestThreadSummary, maxItems);
    return parts.join("\n");
  }

  if (!thread) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push("", "# Thread summary", truncate(summary.trim(), MAX_SUMMARY_CHARS));
    appendOutputContract(parts, requestThreadSummary, maxItems);
    return parts.join("\n");
  }

  const queryWords = keywordSet(latestUserMessage);
  const ranked = thread.comments
    .map((c, i) => ({
      c,
      i,
      score: scoreCommentForQuery(c.body, queryWords),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.c.depth !== b.c.depth) return a.c.depth - b.c.depth;
      return a.i - b.i;
    });

  const selected = ranked.slice(0, MAX_COMMENTS).map((x) => x.c);

  const comments = selected
    .map((c) => {
      const indent = "  ".repeat(Math.min(c.depth, 4));
      const score = c.score ? ` (${c.score})` : "";
      return `${indent}- u/${c.author}${score}: ${truncate(c.body, MAX_COMMENT_CHARS)}`;
    })
    .join("\n");

  const parts = [BASE_SYSTEM];
  if (goalSection) parts.push("", goalSection);
  parts.push(
    "",
    "# Thread",
    `Sub: ${thread.subreddit || "?"}  OP: u/${thread.author || "?"}`,
    `Title: ${thread.title || "(untitled)"}`,
  );
  if (thread.body) parts.push(`Body: ${truncate(thread.body, 500)}`);
  if (summary.trim()) {
    parts.push("", "# Conversation summary", truncate(summary.trim(), MAX_SUMMARY_CHARS));
  }
  if (includeComments) {
    parts.push(
      "",
      `Comments (${selected.length} of ${thread.comments.length}, relevance-ranked):`,
      comments || "(none captured)",
    );
  } else {
    parts.push(
      "",
      "Comments are intentionally excluded for this request.",
      "Focus on drafting direct outreach/DM copy to the post author based on post title/body and conversation context only.",
      "Do not draft or suggest public comment replies unless the user explicitly asks to re-enable comments.",
    );
  }

  appendOutputContract(parts, requestThreadSummary, maxItems);

  return parts.join("\n");
}

export function buildConversionSystemPrompt(
  username: string,
  kind: string,
  subreddit: string,
  originalDraft: string,
  threadSummary: string,
  goal: Goal | null,
): string {
  const goalSection = formatGoalSection(goal);
  const parts = [
    BASE_SYSTEM,
    "",
    "# Outreach context",
    `You previously reached out to u/${username} on r/${subreddit} via ${kind}:`,
    `"${truncate(originalDraft, 400)}"`,
    "",
    "# Thread context",
    truncate(threadSummary.trim(), MAX_SUMMARY_CHARS),
  ];
  if (goalSection) parts.push("", goalSection);
  parts.push(
    "",
    `The user will now tell you what u/${username} replied. Craft a follow-up that:`,
    "- Feels like a natural continuation from the same person who sent the original message",
    "- Moves toward a concrete next step without being pushy (discovery call, free review, etc.)",
    "- Matches the tone of the original outreach and the subreddit culture",
    "- Never sounds like marketing and never mentions AI",
  );
  appendOutputContract(parts, false, goalHasPlaybook(goal) ? 3 : 6);
  return parts.join("\n");
}

export async function* streamReply(
  client: Anthropic,
  system: string,
  history: ChatTurn[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // Trim old turns to keep input tokens low; full history is kept in UI memory
  const trimmed =
    history.length > MAX_HISTORY_TURNS
      ? history.slice(history.length - MAX_HISTORY_TURNS)
      : history;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1400,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" as const } }],
    messages: trimmed.map((t) => ({ role: t.role, content: t.content })),
  }, { signal });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
