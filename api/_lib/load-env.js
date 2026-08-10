const fs = require("fs");
const path = require("path");

let bootstrapped = false;

/** Loaded first — only fill keys that are missing. */
const FILL_FILES = [".env", ".env.development"];
/** Loaded second — on local dev, override Vercel-injected cloud env (e.g. production Polar keys). */
const OVERRIDE_FILES = [".env.local", ".env.development.local"];

function isProductionDeploy() {
  return process.env.VERCEL_ENV === "production";
}

function isLocalDev() {
  return !isProductionDeploy();
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function applyFile(filePath, mode) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (mode === "override") {
      process.env[parsed.key] = parsed.value;
    } else if (process.env[parsed.key] === undefined || process.env[parsed.key] === "") {
      process.env[parsed.key] = parsed.value;
    }
  }
}

/**
 * Load dotenv files. On local dev, `.env.local` wins over Vercel cloud env so you can
 * keep sandbox Polar keys locally while production keys live in the Vercel dashboard.
 */
function loadLocalEnv() {
  if (bootstrapped) return getEnvFileStatus();
  bootstrapped = true;

  const root = path.join(__dirname, "../..");
  const status = getEnvFileStatus();

  for (const name of FILL_FILES) {
    applyFile(path.join(root, name), "fill");
  }

  if (isLocalDev()) {
    for (const name of OVERRIDE_FILES) {
      applyFile(path.join(root, name), "override");
    }
  }

  return status;
}

function getEnvFileStatus() {
  const root = path.join(__dirname, "../..");
  const status = {};
  for (const name of [...FILL_FILES, ...OVERRIDE_FILES]) {
    status[name] = fs.existsSync(path.join(root, name));
  }
  return status;
}

function isMockCheckoutEnabled() {
  if (isProductionDeploy()) return false;
  const v = (process.env.MOCK_CHECKOUT || process.env.CHECKOUT_MOCK || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

module.exports = {
  loadLocalEnv,
  getEnvFileStatus,
  isLocalDev,
  isProductionDeploy,
  isMockCheckoutEnabled,
};
