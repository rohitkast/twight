const { loadLocalEnv, getEnvFileStatus, isLocalDev, isMockCheckoutEnabled } = require("./_lib/load-env");
loadLocalEnv();

const { HOSTED_GEMINI_MODEL, POLAR_PRODUCT_ID } = require("./_lib/supabase");
const { getPolarAccessToken, getPolarClient, getPolarServerInfo, normalizeEnvToken } = require("./_lib/polar");

module.exports = async function handler(req, res) {
  let hasPolarAccessToken = false;
  try {
    hasPolarAccessToken = Boolean(getPolarAccessToken());
  } catch {
    hasPolarAccessToken = Boolean(normalizeEnvToken(process.env.POLAR_ACCESS_TOKEN));
  }

  const { polarServer, polarServerConfigured } = getPolarServerInfo();

  const payload = {
    ok: true,
    service: "twight-api",
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasGoogleAi: Boolean(process.env.GOOGLE_AI_API_KEY),
    hasPolarSecret: Boolean(process.env.POLAR_WEBHOOK_SECRET),
    hasPolarAccessToken,
    polarServer,
    polarServerConfigured,
    polarProductId: POLAR_PRODUCT_ID,
    hostedGeminiModel: HOSTED_GEMINI_MODEL,
    localDev: isLocalDev(),
    localEnvOverrides: isLocalDev(),
    mockCheckout: isMockCheckoutEnabled(),
    envFiles: getEnvFileStatus(),
  };

  const probe = req.query?.probePolar === "1" || req.query?.probePolar === "true";
  if (probe) {
    try {
      const polar = getPolarClient();
      const product = await polar.products.get({ id: POLAR_PRODUCT_ID });
      payload.polarTokenOk = true;
      payload.polarProductName = product.name || null;
    } catch (e) {
      payload.polarTokenOk = false;
      payload.polarError = (e?.message || String(e)).slice(0, 300);
    }
  }

  res.status(200).json(payload);
};
