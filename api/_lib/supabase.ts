import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export function getAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getAnonClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Fall back to service role for auth verification only if anon missing —
    // prefer setting SUPABASE_ANON_KEY in Vercel too.
    return getAdminClient();
  }
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireUser(req: {
  headers: { authorization?: string | string[] | undefined };
}): Promise<{ user: User; admin: SupabaseClient }> {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header?.startsWith("Bearer ")) {
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

export function corsHeaders(origin?: string | string[] | null): Record<string, string> {
  // Extension pages send chrome-extension:// origins; allow broadly for MVP.
  const allow = typeof origin === "string" ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allow === "null" ? "*" : allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

export const DRAFTS_PER_PACK = Number(process.env.DRAFTS_PER_PACK || 50);
export const POLAR_PRODUCT_ID = process.env.POLAR_PRODUCT_ID || "8e149b00-a6af-4db6-9829-7b983438c08f";
export const HOSTED_GEMINI_MODEL = process.env.HOSTED_GEMINI_MODEL || "gemini-2.5-flash";
