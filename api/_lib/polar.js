const { loadLocalEnv } = require("./load-env");
loadLocalEnv();

const { Polar } = require("@polar-sh/sdk");

function normalizeEnvToken(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.trim().replace(/^["']|["']$/g, "");
}

/** @returns {"sandbox" | "production"} */
function resolvePolarServer() {
  const explicit = (process.env.POLAR_SERVER || "").trim().toLowerCase();
  if (explicit === "sandbox") return "sandbox";
  if (explicit === "production" || explicit === "prod") return "production";
  // POLAR_SANDBOX=1 is an alternate flag (handy when POLAR_SERVER is missing from pulled Vercel env)
  if (process.env.POLAR_SANDBOX === "1" || process.env.POLAR_SANDBOX === "true") return "sandbox";
  return "production";
}

function getPolarServerInfo() {
  const raw = process.env.POLAR_SERVER;
  const configured = Boolean(raw && String(raw).trim());
  const server = resolvePolarServer();
  return { polarServer: server, polarServerConfigured: configured };
}

function getPolarAccessToken() {
  const token = normalizeEnvToken(process.env.POLAR_ACCESS_TOKEN);
  if (!token) {
    throw Object.assign(new Error("Missing POLAR_ACCESS_TOKEN"), {
      status: 500,
      code: "misconfigured",
    });
  }
  if (!token.startsWith("polar_oat_")) {
    throw Object.assign(
      new Error("POLAR_ACCESS_TOKEN should start with polar_oat_ (not the webhook secret whsec_…)"),
      { status: 500, code: "misconfigured" },
    );
  }
  return token;
}

function getPolarClient() {
  return new Polar({
    accessToken: getPolarAccessToken(),
    server: resolvePolarServer(),
  });
}

/** Map Polar SDK / HTTP failures to a clearer API response. */
function formatPolarCheckoutError(err) {
  const message = err?.message || String(err);
  const statusCode = err?.statusCode ?? err?.status;

  if (
    statusCode === 401 ||
    message.includes("invalid_token") ||
    message.includes("Status 401")
  ) {
    const { polarServer, polarServerConfigured } = getPolarServerInfo();
    return {
      status: 502,
      body: {
        error:
          "Polar rejected POLAR_ACCESS_TOKEN. Use a token from the same environment as POLAR_SERVER " +
          `(currently "${polarServer}"). Sandbox tokens need POLAR_SERVER=sandbox. Token needs checkouts:write scope.`,
        code: "polar_invalid_token",
        polarServer,
        polarServerConfigured,
        hint: polarServerConfigured
          ? "POLAR_SERVER is set but Polar still rejected the token — recreate the token with checkouts:write in the matching Polar environment."
          : "POLAR_SERVER is not set in this API process (defaults to production). Add POLAR_SERVER=sandbox to Vercel env or .env, then restart vercel dev.",
      },
    };
  }

  if (statusCode === 403 || message.includes("Status 403")) {
    return {
      status: 502,
      body: {
        error: "Polar token lacks permission. Recreate the token with checkouts:write (and orders:read).",
        code: "polar_forbidden",
        polarServer: resolvePolarServer(),
      },
    };
  }

  return {
    status: typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 500,
    body: {
      error: message || "Checkout failed",
      code: err?.code || "checkout_failed",
      polarServer: resolvePolarServer(),
    },
  };
}

/** Public site origin for checkout success redirects. */
function getAppBaseUrl(req) {
  const configured = process.env.PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.startsWith("http")) {
    return origin.replace(/\/$/, "");
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  if (typeof host === "string" && host) {
    return `${proto}://${host}`.replace(/\/$/, "");
  }

  return "https://twight.vercel.app";
}

module.exports = {
  getPolarClient,
  getPolarAccessToken,
  normalizeEnvToken,
  resolvePolarServer,
  getPolarServerInfo,
  formatPolarCheckoutError,
  getAppBaseUrl,
};
