const { loadLocalEnv } = require("./load-env");
loadLocalEnv();

const { createClient } = require("@supabase/supabase-js");

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw Object.assign(new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"), {
      status: 500,
      code: "misconfigured",
    });
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireUser(req) {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !header.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing authorization"), { status: 401, code: "unauthorized" });
  }
  const token = header.slice(7);
  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    throw Object.assign(new Error("Invalid or expired session"), { status: 401, code: "unauthorized" });
  }
  return { user: data.user, admin };
}

function signupDraftsForUser(user) {
  return user && user.is_anonymous ? 5 : 10;
}

function corsHeaders(origin) {
  const allow = typeof origin === "string" && origin !== "null" ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

/**
 * Normalize Gemini model ids for @google/generative-ai.
 * Vercel env values often get pasted as "gemini-2.5-flash", models/gemini-..., or with spaces —
 * those produce: GenerateContentRequest.model: unexpected model name format
 */
function resolveHostedGeminiModel() {
  const fallback = "gemini-3.6-flash";
  let raw = process.env.HOSTED_GEMINI_MODEL || fallback;
  raw = String(raw).trim().replace(/^["']|["']$/g, "");
  if (!raw) raw = fallback;
  const short = raw.replace(/^models\//, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(short)) {
    console.warn(`Invalid HOSTED_GEMINI_MODEL="${raw}", falling back to ${fallback}`);
    return fallback;
  }
  return short;
}

module.exports = {
  getAdminClient,
  requireUser,
  signupDraftsForUser,
  corsHeaders,
  DRAFTS_PER_PACK: Number(process.env.DRAFTS_PER_PACK || 50),
  POLAR_PRODUCT_ID: process.env.POLAR_PRODUCT_ID || "8e149b00-a6af-4db6-9829-7b983438c08f",
  HOSTED_GEMINI_MODEL: resolveHostedGeminiModel(),
};
