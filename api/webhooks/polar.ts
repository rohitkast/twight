import type { VercelRequest, VercelResponse } from "@vercel/node";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { DRAFTS_PER_PACK, POLAR_PRODUCT_ID, getAdminClient } from "../_lib/supabase";

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function extractEmail(order: Record<string, unknown>): string | null {
  const customer = order.customer as Record<string, unknown> | undefined;
  if (customer && typeof customer.email === "string") return customer.email;
  if (typeof order.customer_email === "string") return order.customer_email;
  const checkout = order.checkout as Record<string, unknown> | undefined;
  if (checkout && typeof checkout.customer_email === "string") return checkout.customer_email;
  return null;
}

function extractProductId(order: Record<string, unknown>): string | null {
  const product = order.product as Record<string, unknown> | undefined;
  if (product && typeof product.id === "string") return product.id;
  if (typeof order.product_id === "string") return order.product_id;
  const items = order.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items) && items[0]) {
    const itemProduct = items[0].product as Record<string, unknown> | undefined;
    if (itemProduct && typeof itemProduct.id === "string") return itemProduct.id;
    if (typeof items[0].product_id === "string") return items[0].product_id as string;
  }
  const productId = (order as { productId?: string }).productId;
  if (typeof productId === "string") return productId;
  return null;
}

function normalizeHeaders(headers: VercelRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value[0]) out[key] = value[0];
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
    const rawBody = await readRawBody(req);
    const event = validateEvent(rawBody, normalizeHeaders(req.headers), secret) as {
      type: string;
      data: Record<string, unknown>;
    };

    if (event.type !== "order.paid") {
      res.status(202).json({ ok: true, ignored: event.type });
      return;
    }

    const order = event.data;
    const orderId = typeof order.id === "string" ? order.id : null;
    const email = extractEmail(order);
    const productId = extractProductId(order);

    if (!orderId || !email) {
      console.error("Polar webhook missing order id or email", { orderId, email });
      res.status(400).json({ error: "Missing order id or customer email" });
      return;
    }

    // Only credit our draft pack product (skip unknown products)
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
    });

    if (error) {
      if ((error.message || "").includes("user_not_found")) {
        console.error("No Twight account for Polar buyer email", email);
        // 200 so Polar doesn't retry forever — user must sign up with same email
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
}
