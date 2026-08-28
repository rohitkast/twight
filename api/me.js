const { corsHeaders, requireUser, signupDraftsForUser } = require("./_lib/supabase");

module.exports = async function handler(req, res) {
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

    if (!profile) {
      const email = user.email || null;
      const bonus = signupDraftsForUser(user);
      const { data: created, error: insertErr } = await admin
        .from("profiles")
        .upsert({ id: user.id, email, drafts_balance: bonus }, { onConflict: "id" })
        .select("drafts_balance, email")
        .single();
      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }
      await admin.from("draft_ledger").insert({
        user_id: user.id,
        delta: bonus,
        reason: user.is_anonymous ? "anon_signup_bonus" : "signup_bonus",
      });
      res.status(200).json({
        email: (created && created.email) || email,
        draftsRemaining: (created && created.drafts_balance) != null ? created.drafts_balance : bonus,
      });
      return;
    }

    res.status(200).json({
      email: profile.email || user.email || null,
      draftsRemaining: profile.drafts_balance != null ? profile.drafts_balance : 0,
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || "Server error",
      code: e.code,
    });
  }
};
