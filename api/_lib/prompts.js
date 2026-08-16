/**
 * Server-owned draft prompts. Extension sends thread/goal data only;
 * BASE_SYSTEM lives here so prompt changes deploy without a Chrome update.
 */

const MAX_PLAYBOOK_CHARS = 2800;
const MAX_COMMENT_CHARS = 300;
const MAX_COMMENTS = 16;
const MAX_SUMMARY_CHARS = 1200;

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "have", "what", "your",
  "just", "they", "them", "into", "about", "would", "there", "could", "should",
  "where", "when", "which", "also", "been", "were", "will", "some", "than",
  "then", "their", "need", "want", "like", "make", "help",
]);

const BASE_SYSTEM = `You draft Reddit replies, comments, and DMs that the human user will send themselves.

Voice (critical):
- Write every draft in first person as the human sender — never as an AI assistant.
- Never narrate about the founder in third person (no "Rohit built…", "X and I built…", "the creator of…").
- Never mention AI, drafts, prompts, or that a tool wrote this.
- If the product must appear later (only after they engage), say "I built…" / "I've been working on…" — singular first person.

Tone:
- Match the subreddit. Sound human, never like marketing copy.
- Lowercase and "..." are fine when it fits; avoid em-dashes and polished sales cadence.
- Be concise unless they clearly want detail.

Targeting:
- Ground every draft in something specific that person actually wrote in the thread.
- Prefer people who match the goal's target types. Skip weak fits (milestone posters with no relevant signal, competitors, wrong channel).
- Never invent facts or channels (e.g. do not assume they use Reddit unless they said so). Prefer a public comment over a cold DM on celebration/milestone posts.

First-touch drafts (default for new outreach — dm, reply, or comment):
- Goal of message 1 is to start a conversation (get a reply), not to pitch or close.
- Reference one specific thing they said → show you get their problem (not your solution) → ask exactly ONE question.
- No product name, no pitch, no "I help X do Y", no soft CTA, no scheduling ask, no links.
- Put any product angle only in the rationale field for the sender — not in the message text.

When they already replied / asked for more (follow-ups or explicit user instruction):
- Then you may introduce the product gently, answer questions, or share a link if they asked.
- Still sound human; never dump a pitch deck.

Other:
- Give the draft directly. Ask the Twight user one clarifying question only if truly ambiguous.
- Never invent facts beyond what is provided.
- Comments may be truncated for brevity. Never mention or allude to truncation, missing text, or incomplete comments in any draft.`;

function goalHasPlaybook(goal) {
  return !!(goal && typeof goal.playbook === "string" && goal.playbook.trim());
}

function formatGoalSection(goal) {
  if (!goal) return null;
  if (goalHasPlaybook(goal)) {
    let playbook = String(goal.playbook || "").trim();
    if (playbook.length > MAX_PLAYBOOK_CHARS) {
      playbook = playbook.slice(0, MAX_PLAYBOOK_CHARS) + "…";
    }
    const parts = [`# Goal\n${goal.name || "Goal"}`, "", playbook];
    if (Array.isArray(goal.targetTypes) && goal.targetTypes.length) {
      parts.push(
        "",
        "# Target types (prefer these; skip weak fits)",
        ...goal.targetTypes.filter((t) => typeof t === "string" && t.trim()).map((t) => `- ${t}`),
      );
    }
    return parts.join("\n");
  }
  const name = goal.name || "Goal";
  const description = goal.description || "";
  return `# Goal\n${name}: ${description}`;
}

function appendOutputContract(parts, requestThreadSummary, maxItems = 6) {
  const capped = Math.max(1, Math.min(6, maxItems));
  parts.push(
    "",
    "Output contract:",
    "Emit each draft in its own frame using <ITEM>JSON</ITEM>.",
    "JSON fields: kind (dm|reply|comment), targetUser (string or null), title, text, rationale.",
    `Emit 1-${capped} items (prefer fewer, complete frames over many truncated ones). No markdown code fences.`,
    "Finish every ITEM frame — never leave JSON unclosed.",
  );

  if (requestThreadSummary) {
    parts.push(
      "",
      "After all ITEM frames, append a concise thread summary for future turns in this exact format:",
      "<THREAD_SUMMARY>",
      "2-6 bullet points capturing core problem, key commenters, objections, and best conversation-starter angle (not a pitch).",
      "</THREAD_SUMMARY>",
      "Keep this summary under 900 characters.",
    );
  }
}

function truncate(s, max) {
  const str = String(s || "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function keywordSet(text) {
  const words = (String(text || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
  return new Set(words);
}

function scoreCommentForQuery(body, queryWords) {
  if (!queryWords.size) return 0;
  const bodyWords = keywordSet(body);
  let overlap = 0;
  for (const w of queryWords) {
    if (bodyWords.has(w)) overlap += 1;
  }
  return overlap;
}

function sanitizeGoal(goal) {
  if (!goal || typeof goal !== "object") return null;
  return {
    id: typeof goal.id === "string" ? goal.id.slice(0, 80) : "",
    name: typeof goal.name === "string" ? goal.name.slice(0, 200) : "Goal",
    description: typeof goal.description === "string" ? goal.description.slice(0, 2000) : "",
    product: typeof goal.product === "string" ? goal.product.slice(0, 2000) : undefined,
    intent: typeof goal.intent === "string" ? goal.intent.slice(0, 2000) : undefined,
    avoid: typeof goal.avoid === "string" ? goal.avoid.slice(0, 2000) : undefined,
    playbook: typeof goal.playbook === "string" ? goal.playbook.slice(0, MAX_PLAYBOOK_CHARS + 50) : undefined,
    targetTypes: Array.isArray(goal.targetTypes)
      ? goal.targetTypes.filter((t) => typeof t === "string").map((t) => t.slice(0, 80)).slice(0, 8)
      : undefined,
  };
}

function sanitizeThread(thread) {
  if (!thread || typeof thread !== "object") return null;
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  return {
    url: typeof thread.url === "string" ? thread.url.slice(0, 500) : "",
    subreddit: typeof thread.subreddit === "string" ? thread.subreddit.slice(0, 120) : "",
    title: typeof thread.title === "string" ? thread.title.slice(0, 500) : "",
    author: typeof thread.author === "string" ? thread.author.slice(0, 120) : "",
    body: typeof thread.body === "string" ? thread.body.slice(0, 8000) : "",
    comments: comments.slice(0, 80).map((c) => ({
      author: typeof c?.author === "string" ? c.author.slice(0, 120) : "unknown",
      body: typeof c?.body === "string" ? c.body.slice(0, 2000) : "",
      depth: typeof c?.depth === "number" ? Math.min(Math.max(0, c.depth), 20) : 0,
      score: typeof c?.score === "string" ? c.score.slice(0, 32) : undefined,
    })),
  };
}

function buildSystemPrompt(thread, goal = null, latestUserMessage = "", context = {}) {
  const {
    summary = "",
    includeRawThread = true,
    requestThreadSummary = false,
    includeComments = true,
  } = context || {};

  const goalSection = formatGoalSection(goal);
  const maxItems = goalHasPlaybook(goal) ? 3 : 6;

  if (!thread && !String(summary || "").trim()) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push('\nNo thread loaded. Ask the user to click "Load thread from page".');
    appendOutputContract(parts, requestThreadSummary, maxItems);
    return parts.join("\n");
  }

  if (!includeRawThread && String(summary || "").trim()) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push(
      "",
      "# Thread summary",
      truncate(String(summary).trim(), MAX_SUMMARY_CHARS),
      "",
      "Use only this summary as thread context. Do not ask for raw post/comments unless essential.",
    );
    appendOutputContract(parts, requestThreadSummary, maxItems);
    return parts.join("\n");
  }

  if (!thread) {
    const parts = [BASE_SYSTEM];
    if (goalSection) parts.push("", goalSection);
    parts.push("", "# Thread summary", truncate(String(summary).trim(), MAX_SUMMARY_CHARS));
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
  if (String(summary || "").trim()) {
    parts.push("", "# Conversation summary", truncate(String(summary).trim(), MAX_SUMMARY_CHARS));
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

function buildConversionSystemPrompt(username, kind, subreddit, originalDraft, threadSummary, goal) {
  const goalSection = formatGoalSection(goal);
  const parts = [
    BASE_SYSTEM,
    "",
    "# Outreach context",
    `You previously reached out to u/${username} on r/${subreddit} via ${kind}:`,
    `"${truncate(originalDraft, 400)}"`,
    "",
    "# Thread context",
    truncate(String(threadSummary || "").trim(), MAX_SUMMARY_CHARS),
  ];
  if (goalSection) parts.push("", goalSection);
  parts.push(
    "",
    `The Twight user will now tell you what u/${username} replied. Craft a follow-up that:`,
    "- Is written in first person as the same human who sent the original message (never third-person founder narration, never AI voice)",
    "- Feels like a natural continuation of that conversation",
    "- Because they already replied, you may gently introduce the product or answer what they asked — still no hard sell",
    "- Move toward a concrete next step only if it fits (e.g. they asked what you built, wanted a link, or invited more detail)",
    "- Matches the tone of the original outreach and the subreddit culture",
    "- Never sounds like marketing copy and never mentions AI or Twight",
  );
  appendOutputContract(parts, false, goalHasPlaybook(goal) ? 3 : 6);
  return parts.join("\n");
}

/**
 * Resolve the system prompt for a generate request.
 * - v2 (`body.prompt`): build on server; ignore any client `system` string.
 * - legacy: use client `system` so older extension builds keep working until store approval.
 */
function resolveSystemPrompt(body) {
  const prompt = body && body.prompt;
  if (prompt && typeof prompt === "object" && (prompt.mode === "live" || prompt.mode === "followup")) {
    if (prompt.mode === "followup") {
      const fu = prompt.followUp && typeof prompt.followUp === "object" ? prompt.followUp : {};
      return {
        source: "server",
        system: buildConversionSystemPrompt(
          String(fu.username || "").slice(0, 120),
          String(fu.kind || "dm").slice(0, 32),
          String(fu.subreddit || "").slice(0, 120),
          String(fu.originalDraft || "").slice(0, 4000),
          String(fu.threadSummary || "").slice(0, MAX_SUMMARY_CHARS + 100),
          sanitizeGoal(prompt.goal),
        ),
      };
    }

    const context = prompt.context && typeof prompt.context === "object" ? prompt.context : {};
    return {
      source: "server",
      system: buildSystemPrompt(
        sanitizeThread(prompt.thread),
        sanitizeGoal(prompt.goal),
        typeof prompt.latestUserMessage === "string" ? prompt.latestUserMessage.slice(0, 4000) : "",
        {
          summary: typeof context.summary === "string" ? context.summary.slice(0, MAX_SUMMARY_CHARS + 200) : "",
          includeRawThread: context.includeRawThread !== false,
          requestThreadSummary: !!context.requestThreadSummary,
          includeComments: context.includeComments !== false,
        },
      ),
    };
  }

  if (typeof body.system === "string" && body.system.trim()) {
    return { source: "legacy-client", system: body.system };
  }

  return { source: "missing", system: null };
}

module.exports = {
  BASE_SYSTEM,
  buildSystemPrompt,
  buildConversionSystemPrompt,
  resolveSystemPrompt,
};
