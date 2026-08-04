import type { VercelRequest, VercelResponse } from "@vercel/node";
import { corsHeaders, requireUser } from "./_lib/supabase";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const headers = corsHeaders(req.headers.origin);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { user, admin } = await requireUser(req);
    const { data: profile, error } = await admin
      .from("profiles")
      .select("drafts_balance, email")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Backfill profile if trigger missed (e.g. user created before schema)
    if (!profile) {
      const email = user.email ?? null;
      const { data: created, error: insertErr } = await admin
        .from("profiles")
        .upsert({ id: user.id, email, drafts_balance: 10 }, { onConflict: "id" })
        .select("drafts_balance, email")
        .single();
      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }
      await admin.from("draft_ledger").insert({
        user_id: user.id,
        delta: 10,
        reason: "signup_bonus",
      });
      res.status(200).json({
        email: created.email ?? email,
        draftsRemaining: created.drafts_balance ?? 10,
      });
      return;
    }

    res.status(200).json({
      email: profile.email ?? user.email ?? null,
      draftsRemaining: profile.drafts_balance ?? 0,
    });
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    res.status(err.status || 500).json({
      error: err.message || "Server error",
      code: err.code,
    });
  }
}
