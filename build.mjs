import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Copy static assets (manifest, HTML, CSS) into dist/
await cp("public", outdir, { recursive: true });

// The Anthropic SDK statically imports Node built-ins (node:fs, node:path, …)
// for file-based / WIF credential flows we never use — we pass an explicit API
// key. Stub them to empty CommonJS modules so the unused code bundles for the
// browser. (Named imports from a CJS stub resolve to undefined, not a build
// error; these symbols are only touched inside code paths we don't trigger.)
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

const ctx = await esbuild.context({
  plugins: [stubNodeBuiltins],
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    sidepanel: "src/sidepanel.ts",
    options: "src/options.ts",
    goals: "src/goals.ts",
  },
  bundle: true,
  // iife keeps each output a classic script — required for content scripts and
  // the simplest option for the service worker and extension pages.
  format: "iife",
  platform: "browser",
  target: "es2022",
  outdir,
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  await cp("public", outdir, { recursive: true });
  console.log("watching for changes…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("build complete → dist/");
}
