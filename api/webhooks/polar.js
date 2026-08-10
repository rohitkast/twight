const { validateEvent, WebhookVerificationError } = require("@polar-sh/sdk/webhooks");
const { DRAFTS_PER_PACK, POLAR_PRODUCT_ID, getAdminClient } = require("../_lib/supabase");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Missing POLAR_WEBHOOK_SECRET" });
    return;
  }

  try {
    // With bodyParser disabled, Vercel may still parse — prefer raw if present
    let rawBody;
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body;
    } else if (typeof req.body === "string") {
      rawBody = Buffer.from(req.body);
    } else if (req.body && typeof req.body === "object") {
      rawBody = Buffer.from(JSON.stringify(req.body));
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      rawBody = Buffer.concat(chunks);
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value) && value[0]) headers[key] = value[0];
    }

    const event = validateEvent(rawBody, headers, secret);

    if (event.type !== "order.paid") {
      res.status(202).json({ ok: true, ignored: event.type });
      return;
    }

    const order = event.data || {};
    const orderId = typeof order.id === "string" ? order.id : null;
    const customer = order.customer || {};
    const email =
      (typeof customer.email === "string" && customer.email) ||
      (typeof order.customer_email === "string" && order.customer_email) ||
      null;
    const metadata = order.metadata && typeof order.metadata === "object" ? order.metadata : {};
    const userIdRaw =
      metadata.supabase_user_id ||
      metadata.supabaseUserId ||
      customer.external_id ||
      customer.externalId ||
      order.external_customer_id ||
      order.externalCustomerId ||
      null;
    const userId =
      typeof userIdRaw === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userIdRaw)
        ? userIdRaw
        : null;
    const product = order.product || {};
    const productId =
      (typeof product.id === "string" && product.id) ||
      (typeof order.product_id === "string" && order.product_id) ||
      null;

    if (!orderId || !email) {
      console.error("Polar webhook missing order id or email", { orderId, email });
      res.status(400).json({ error: "Missing order id or customer email" });
      return;
    }

    if (productId && productId !== POLAR_PRODUCT_ID) {
      console.warn("Ignoring order for unexpected product", { productId, expected: POLAR_PRODUCT_ID });
      res.status(202).json({ ok: true, ignored: "wrong_product" });
      return;
    }

    const admin = getAdminClient();
    const { data, error } = await admin.rpc("add_drafts_from_order", {
      p_order_id: orderId,
      p_email: email,
      p_drafts: DRAFTS_PER_PACK,
      p_user_id: userId,
    });

    if (error) {
      if ((error.message || "").includes("user_not_found")) {
        console.error("No Twight account for Polar buyer email", email);
        res.status(200).json({
          ok: false,
          error: "user_not_found",
          hint: "Buyer email has no Twight account",
        });
        return;
      }
      console.error("add_drafts_from_order failed", error);
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ ok: true, draftsRemaining: data });
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      res.status(403).json({ error: "Invalid signature" });
      return;
    }
    console.error("Polar webhook error", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "Webhook failed" });
  }
};

// Need raw body for Polar signature verification
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
