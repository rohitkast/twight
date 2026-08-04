module.exports = async function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "twight-api",
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasGoogleAi: Boolean(process.env.GOOGLE_AI_API_KEY),
    hasPolarSecret: Boolean(process.env.POLAR_WEBHOOK_SECRET),
  });
};
