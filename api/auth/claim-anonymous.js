const { corsHeaders, requireUser } = require("../_lib/supabase");

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
    if (user.is_anonymous) {
      res.status(400).json({ error: "Sign in with Google first.", code: "anonymous" });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const anonymousUserId = typeof body.anonymousUserId === "string" ? body.anonymousUserId.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(anonymousUserId)) {
      res.status(400).json({ error: "Invalid anonymousUserId", code: "invalid_args" });
      return;
    }

    const { data, error } = await admin.rpc("claim_anonymous", {
      p_google_id: user.id,
      p_anon_id: anonymousUserId,
    });

    if (error) {
      const msg = error.message || "Claim failed";
      const code = msg.includes("not_anonymous") ? "not_anonymous" : "claim_failed";
      res.status(code === "not_anonymous" ? 400 : 500).json({ error: msg, code });
      return;
    }

    if (user.email) {
      await admin.from("profiles").update({ email: user.email }).eq("id", user.id);
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("email, drafts_balance")
      .eq("id", user.id)
      .maybeSingle();

    res.status(200).json({
      email: (profile && profile.email) || user.email || null,
      draftsRemaining: typeof data === "number" ? data : (profile && profile.drafts_balance) || 0,
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      res.status(400).json({ error: "Invalid JSON", code: "invalid_args" });
      return;
    }
    res.status(e.status || 500).json({
      error: e.message || "Server error",
      code: e.code,
    });
  }
};
