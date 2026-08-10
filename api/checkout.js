const { loadLocalEnv, isMockCheckoutEnabled } = require("./_lib/load-env");
loadLocalEnv();

const { corsHeaders, DRAFTS_PER_PACK, POLAR_PRODUCT_ID, requireUser } = require("./_lib/supabase");
const { formatPolarCheckoutError, getAppBaseUrl, getPolarClient } = require("./_lib/polar");

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
    const email = user.email;
    if (!email) {
      res.status(400).json({
        error: "Your account has no email. Sign in with Google to buy drafts.",
        code: "no_email",
      });
      return;
    }

    const baseUrl = getAppBaseUrl(req);

    // Local-only: skip Polar entirely — credits drafts and opens /success (see SETUP.md).
    if (isMockCheckoutEnabled()) {
      const orderId = `mock_local_${user.id}_${Date.now()}`;
      const { data, error } = await admin.rpc("add_drafts_from_order", {
        p_order_id: orderId,
        p_email: email,
        p_drafts: DRAFTS_PER_PACK,
        p_user_id: user.id,
      });
      if (error) {
        res.status(500).json({ error: error.message, code: "mock_checkout_failed" });
        return;
      }
      res.status(200).json({
        url: `${baseUrl}/success?checkout_id=${encodeURIComponent(orderId)}&mock=1`,
        mock: true,
        draftsRemaining: data,
      });
      return;
    }

    const polar = getPolarClient();
    const checkout = await polar.checkouts.create({
      products: [POLAR_PRODUCT_ID],
      customerEmail: email,
      externalCustomerId: user.id,
      metadata: { supabase_user_id: user.id },
      successUrl: `${baseUrl}/success?checkout_id={CHECKOUT_ID}`,
    });

    if (!checkout.url) {
      res.status(500).json({ error: "Polar did not return a checkout URL" });
      return;
    }

    res.status(200).json({ url: checkout.url });
  } catch (e) {
    if (e.status && e.code && !String(e.message || "").includes("Polar")) {
      res.status(e.status).json({ error: e.message, code: e.code });
      return;
    }
    const { status, body } = formatPolarCheckoutError(e);
    res.status(status).json(body);
  }
};
