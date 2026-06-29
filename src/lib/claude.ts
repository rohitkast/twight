import Anthropic from "@anthropic-ai/sdk";
import type { RedditThread, Goal } from "./types";

export const MODEL = "claude-opus-4-8";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export function getClient(apiKey: string): Anthropic {
  // dangerouslyAllowBrowser is required to call the API from a browser/extension
  // context. Safe here because the key is the user's own, stored only in this browser.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// Input token budget: truncate aggressively to keep prompt small across turns.
const MAX_COMMENT_CHARS = 400;
const MAX_COMMENTS = 60;
const MAX_HISTORY_TURNS = 8; // 4 exchanges kept in each API call

const BASE_SYSTEM = `You help craft tailored Reddit replies and DMs.
Given a Reddit thread:
- Match the subreddit's tone. Sound human, never like marketing copy or AI.
- Ground DMs in what the specific user actually wrote in the thread.
- Give the draft directly. Ask one clarifying question only if truly ambiguous.
- Never invent facts beyond what is provided.`;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function buildSystemPrompt(thread: RedditThread | null, goal: Goal | null = null): string {
  const goalSection = goal ? `# Goal\n${goal.name}: ${goal.description}` : null;

  if (!thread) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push('\nNo thread loaded. Ask the user to click "Load thread from page".');
    return parts.join("\n");
  }

  // Prefer shallower comments (more useful context) and cap total count
  const sorted = [...thread.comments].sort((a, b) => a.depth - b.depth);
  const selected = sorted.slice(0, MAX_COMMENTS);

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
  if (thread.body) parts.push(`Body: ${truncate(thread.body, 800)}`);
  parts.push(
    "",
    `Comments (${selected.length}${sorted.length > MAX_COMMENTS ? ` of ${sorted.length}, shallower first` : ""}):`,
    comments || "(none captured)",
  );

  return parts.join("\n");
}

export async function* streamReply(
  client: Anthropic,
  system: string,
  history: ChatTurn[],
): AsyncGenerator<string> {
  // Trim old turns to keep input tokens low; full history is kept in UI memory
  const trimmed =
    history.length > MAX_HISTORY_TURNS
      ? history.slice(history.length - MAX_HISTORY_TURNS)
      : history;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: trimmed.map((t) => ({ role: t.role, content: t.content })),
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
