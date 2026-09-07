const { corsHeaders, requireUser, applyInstallGrant } = require("./_lib/supabase");

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

    let draftsRemaining;
    let email = user.email || null;

    if (!profile) {
      const { data: created, error: insertErr } = await admin
        .from("profiles")
        .upsert({ id: user.id, email, drafts_balance: 0 }, { onConflict: "id" })
        .select("drafts_balance, email")
        .single();
      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }
      email = (created && created.email) || email;
      draftsRemaining = (created && created.drafts_balance) != null ? created.drafts_balance : 0;
    } else {
      email = profile.email || email;
      draftsRemaining = profile.drafts_balance != null ? profile.drafts_balance : 0;
    }

    const grant = await applyInstallGrant(admin, user, req);
    if (grant.draftsRemaining != null) {
      draftsRemaining = grant.draftsRemaining;
    }

    res.status(200).json({
      email,
      draftsRemaining,
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || "Server error",
      code: e.code,
    });
  }
};
