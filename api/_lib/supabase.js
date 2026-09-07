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

function isAuthAnonymous(user) {
  if (!user) return false;
  if (user.is_anonymous === true) return true;
  const identities = user.identities;
  if (!Array.isArray(identities)) return false;
  return identities.some((i) => i && i.provider === "anonymous");
}

/** Guest +5 is per Chrome install, not per auth user. Never grant here. */
function signupDraftsForUser(_user) {
  return 0;
}

function installIdFromReq(req) {
  const raw = req.headers["x-twight-install-id"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return null;
  const id = header.trim();
  if (id.length < 8 || id.length > 80) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return null;
  return id;
}

/** First guest on this install gets 5. Later guests on the same install get 0. */
async function applyInstallGrant(admin, user, req) {
  const anon = isAuthAnonymous(user);
  const installId = installIdFromReq(req);
  if (!installId) {
    return { draftsRemaining: anon ? 0 : null, error: anon ? "missing_install_id" : null };
  }
  const { data, error } = await admin.rpc("register_install_grant", {
    p_install_id: installId,
    p_user_id: user.id,
    p_is_anonymous: anon,
  });
  if (error) {
    console.error("register_install_grant failed", error);
    return { draftsRemaining: anon ? 0 : null, error };
  }
  if (typeof data === "number") return { draftsRemaining: data, error: null };
  return { draftsRemaining: null, error: null };
}

function corsHeaders(origin) {
  const allow = typeof origin === "string" && origin !== "null" ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Twight-Install-Id",
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
  isAuthAnonymous,
  signupDraftsForUser,
  installIdFromReq,
  applyInstallGrant,
  corsHeaders,
  DRAFTS_PER_PACK: Number(process.env.DRAFTS_PER_PACK || 50),
  POLAR_PRODUCT_ID: process.env.POLAR_PRODUCT_ID || "8e149b00-a6af-4db6-9829-7b983438c08f",
  HOSTED_GEMINI_MODEL: resolveHostedGeminiModel(),
};
