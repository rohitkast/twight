const { GoogleGenerativeAI } = require("@google/generative-ai");
const { corsHeaders, HOSTED_GEMINI_MODEL, requireUser } = require("./_lib/supabase");

const MAX_HISTORY_TURNS = 6;
const MAX_SYSTEM_CHARS = 24000;
const MAX_MESSAGE_CHARS = 8000;
const DRAFTS_FOOTER_PREFIX = "<!--__TWIGHT_DRAFTS__:";

module.exports = async function handler(req, res) {
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

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (typeof body.system !== "string" || !Array.isArray(body.history)) {
      res.status(400).json({ error: "Invalid body — expected { system, history }" });
      return;
    }

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("drafts_balance")
      .eq("id", user.id)
      .maybeSingle();

    if (profileErr) {
      res.status(500).json({ error: profileErr.message });
      return;
    }

    const balance = profile?.drafts_balance ?? 0;
    if (balance <= 0) {
      res.status(402).json({
        error: "No drafts left. Buy more to continue.",
        code: "insufficient_drafts",
        draftsRemaining: 0,
      });
      return;
    }

    const system = body.system.slice(0, MAX_SYSTEM_CHARS);
    const history = body.history
      .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t) => ({
        role: t.role,
        content: t.content.slice(0, MAX_MESSAGE_CHARS),
      }));

    if (history.length === 0) {
      res.status(400).json({ error: "history must include at least one turn" });
      return;
    }

    const trimmed =
      history.length > MAX_HISTORY_TURNS
        ? history.slice(history.length - MAX_HISTORY_TURNS)
        : history;

    const lastTurn = trimmed[trimmed.length - 1];
    const priorTurns = trimmed.slice(0, -1);
    const lastUserMsg = (lastTurn && lastTurn.content) || "";

    const geminiHistory = priorTurns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    }));

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: HOSTED_GEMINI_MODEL,
      systemInstruction: system,
      generationConfig: { maxOutputTokens: 2800 },
    });

    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessageStream(lastUserMsg);

    let wroteAny = false;
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (!text) continue;
      if (!wroteAny) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Hosted-Model", HOSTED_GEMINI_MODEL);
        res.status(200);
        wroteAny = true;
      }
      res.write(text);
    }

    if (!wroteAny) {
      res.status(502).json({ error: "Empty model response — no draft was used." });
      return;
    }

    // Charge only after a successful, non-empty streamed response.
    const { data: newBalance, error: deductErr } = await admin.rpc("deduct_draft", {
      p_user_id: user.id,
    });

    if (deductErr) {
      console.error("deduct_draft failed after successful stream", deductErr);
      res.end();
      return;
    }

    res.write(`\n${DRAFTS_FOOTER_PREFIX}${newBalance != null ? newBalance : balance - 1}-->`);
    res.end();
  } catch (e) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(e.status || 500).json({
      error: e.message || "Server error",
      code: e.code,
    });
  }
};
