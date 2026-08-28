/** Public client config — safe to ship in the extension bundle. */

export const API_BASE_URL = "http://localhost:3000";
export const SUPABASE_URL = "https://rcbnajyufootjbpncwxz.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjYm5hanl1Zm9vdGpicG5jd3h6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4MTYyMDUsImV4cCI6MjEwMTM5MjIwNX0.jC7yJrynfE2HiXUKHSLQV1eVF4ESUdQQIQEW593NdOA";

export const PRICING_URL = `${API_BASE_URL}/pricing`;

export const FREE_DRAFTS_ANONYMOUS = 5;
export const FREE_DRAFTS_ON_SIGNUP = 10;
export const DRAFTS_PER_PACK = 50;
export const PACK_PRICE_LABEL = "$5";

/** Parked BYOK path — do not enable until Phase 2. */
export const BYOK_ENABLED = false;
