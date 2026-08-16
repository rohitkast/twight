const { GoogleGenerativeAI } = require("@google/generative-ai");
const { corsHeaders, HOSTED_GEMINI_MODEL, requireUser } = require("./_lib/supabase");

const MAX_FIELD = 2000;

const META_SYSTEM = `You write outreach playbooks for Twight, a Chrome extension that drafts Reddit replies, comments, and DMs.

Given the user's product/service and what they want from draft generation, output a JSON object with:
{
  "playbook": string,
  "targetTypes": string[]  // exactly 2 or 3 short ICP labels
}

The playbook is injected into the drafting model as the user's Goal. It must be actionable and concise (roughly 250–550 words). Use clear markdown-ish headings and bullets. Include ALL of the following sections:

1) Product one-liner — what they offer in plain language (no pitch deck).
2) Desired outcome — feedback / beta users / freelance clients / etc.
3) Hard ICP — who to target, with required signals from the post or comments (e.g. mentioned Reddit outreach, asking for help finding clients, complaining about manual DMs).
4) Negative ICP — who to skip (milestone OPs with no relevant channel signal, competitors building adjacent tools, people whose growth story is clearly another channel with no Reddit/outreach mention).
5) Channel rules — when to use public comment vs DM; on celebration/milestone posts default to comment unless strong fit.
6) Don't invent — never assume they use Reddit, need the product, or share the user's channel unless evidenced in the thread.
7) First-touch style — conversation starter only: reference something specific they said, show you understand their problem (not your solution), ask ONE question. Forbid product name, pitch, "I help X do Y", soft CTAs, scheduling asks, and links in message 1. Pitch/product intro only after they reply or explicitly ask.
8) Voice — drafts are first person as the human sender; never third-person founder names; never AI narration.
9) Optional: 1–2 example opener angles (not full messages) that fit their goal — question-led, no pitch.

targetTypes: 2–3 short chip labels (3–8 words each) naming who to seek in threads. Make them specific and actionable (not "indie hackers" alone — e.g. "Indie hackers doing Reddit outreach").

Do not invent product features the user did not mention. Do not mention Twight unless the user's product IS Twight. Output JSON only.`;

function clip(s, max = MAX_FIELD) {
  return String(s || "").trim().slice(0, max);
}

function parsePlaybookJson(raw) {
  let text = String(raw || "").trim();
  // Strip accidental fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const data = JSON.parse(text);
  const playbook = typeof data.playbook === "string" ? data.playbook.trim() : "";
  let targetTypes = Array.isArray(data.targetTypes)
    ? data.targetTypes
        .filter((t) => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  if (!playbook) throw new Error("Model returned empty playbook");
  if (targetTypes.length < 2) {
    // Soft fallback — keep whatever we got; UI can still add chips
    if (targetTypes.length === 0) targetTypes = ["People with a clear need for this offer"];
  }
  return { playbook, targetTypes: targetTypes.slice(0, 3) };
}

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
    const name = clip(body.name, 120);
    const product = clip(body.product);
    const intent = clip(body.intent);
    const avoid = clip(body.avoid);
    const isRegenerate = Boolean(body.isRegenerate);

    if (!name || !product || !intent) {
      res.status(400).json({
        error: "name, product, and intent are required",
        code: "invalid_body",
      });
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

    let balance = profile?.drafts_balance ?? 0;

    // First playbook gen is free; regenerate costs 1 draft.
    if (isRegenerate) {
      if (balance <= 0) {
        res.status(402).json({
          error: "No drafts left. Buy more to regenerate this playbook.",
          code: "insufficient_drafts",
          draftsRemaining: 0,
        });
        return;
      }
    }

    const userBlock = [
      `Goal name: ${name}`,
      `Product / service: ${product}`,
      `What they want from drafts: ${intent}`,
      avoid ? `Avoid: ${avoid}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: HOSTED_GEMINI_MODEL,
      systemInstruction: META_SYSTEM,
      generationConfig: {
        maxOutputTokens: 1800,
        responseMimeType: "application/json",
      },
    });

    const result = await model.generateContent(
      `Build an outreach playbook and target types for this Twight user:\n\n${userBlock}`,
    );
    const rawText = result.response.text();
    let playbook;
    let targetTypes;
    try {
      ({ playbook, targetTypes } = parsePlaybookJson(rawText));
    } catch (parseErr) {
      console.error("generate-goal parse failed", parseErr, rawText?.slice?.(0, 400));
      res.status(502).json({
        error: "Could not parse playbook from model. Try again.",
        code: "playbook_parse_failed",
      });
      return;
    }

    let charged = false;
    if (isRegenerate) {
      const { data: newBalance, error: deductErr } = await admin.rpc("deduct_draft", {
        p_user_id: user.id,
      });
      if (deductErr) {
        console.error("deduct_draft failed after goal playbook", deductErr);
        if (String(deductErr.message || "").includes("insufficient_drafts")) {
          res.status(402).json({
            error: "No drafts left. Buy more to regenerate this playbook.",
            code: "insufficient_drafts",
            draftsRemaining: 0,
          });
          return;
        }
        // Generation succeeded; return playbook even if debit annotation failed.
      } else {
        charged = true;
        balance = newBalance != null ? newBalance : Math.max(0, balance - 1);
      }
    } else {
      const { data: fresh } = await admin
        .from("profiles")
        .select("drafts_balance")
        .eq("id", user.id)
        .maybeSingle();
      if (fresh?.drafts_balance != null) balance = fresh.drafts_balance;
    }

    res.status(200).json({
      playbook,
      targetTypes,
      draftsRemaining: balance,
      charged,
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || "Server error",
      code: e.code,
    });
  }
};
