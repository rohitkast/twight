import { cp, mkdir, rm } from "node:fs/promises";

const out = "vercel-static";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp("marketing", `${out}/marketing`, { recursive: true });
await cp("public", `${out}/public`, { recursive: true });

console.log("vercel-static ready → marketing/ + public/");
