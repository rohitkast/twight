import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { corsHeaders, HOSTED_GEMINI_MODEL, requireUser } from "./_lib/supabase";

const MAX_HISTORY_TURNS = 6;
const MAX_SYSTEM_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 8_000;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const headers = corsHeaders(req.headers.origin);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { user, admin } = await requireUser(req);
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "Server misconfigured (missing GOOGLE_AI_API_KEY)" });
      return;
    }

    const body = req.body as { system?: unknown; history?: unknown };
    if (typeof body?.system !== "string" || !Array.isArray(body.history)) {
      res.status(400).json({ error: "Invalid body — expected { system, history }" });
      return;
    }

    const system = body.system.slice(0, MAX_SYSTEM_CHARS);
    const history = (body.history as ChatTurn[])
      .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t) => ({
        role: t.role,
        content: t.content.slice(0, MAX_MESSAGE_CHARS),
      }));

    if (history.length === 0) {
      res.status(400).json({ error: "history must include at least one turn" });
      return;
    }

    // Deduct one draft before calling the model
    const { data: newBalance, error: deductErr } = await admin.rpc("deduct_draft", {
      p_user_id: user.id,
    });

    if (deductErr) {
      const msg = deductErr.message || "";
      if (msg.includes("insufficient_drafts")) {
        res.status(402).json({
          error: "No drafts left. Buy more to continue.",
          code: "insufficient_drafts",
          draftsRemaining: 0,
        });
        return;
      }
      res.status(500).json({ error: deductErr.message });
      return;
    }

    const trimmed =
      history.length > MAX_HISTORY_TURNS
        ? history.slice(history.length - MAX_HISTORY_TURNS)
        : history;

    const lastTurn = trimmed.at(-1);
    const priorTurns = trimmed.slice(0, -1);
    const lastUserMsg = lastTurn?.content ?? "";

    const geminiHistory = priorTurns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    }));

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: HOSTED_GEMINI_MODEL,
      systemInstruction: system,
      generationConfig: { maxOutputTokens: 1400 },
    });

    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessageStream(lastUserMsg);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Drafts-Remaining", String(newBalance ?? ""));
    res.status(200);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) res.write(text);
    }
    res.end();
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(err.status || 500).json({
      error: err.message || "Server error",
      code: err.code,
    });
  }
}
