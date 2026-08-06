// Builds index.html — one self-contained page, no external requests for code or styling.
//
// ⚠️ THE PAGE TEMPLATE IS A SEPARATE FILE (`shell.html`), NOT A TEMPLATE LITERAL IN HERE, AND THAT
// IS DELIBERATE. Inte-Run's `web/app.ts`, the project this was built alongside, holds its entire
// runtime inside one giant JS template literal, which means no backtick may appear anywhere in the
// app's own code — not even in a comment — on pain of a silent build failure. That rule fired at
// least six times over there, twice hiding behind a stale build that still passed. Keeping the HTML
// in its own file means the app's JavaScript is just JavaScript: backticks, `${}` and newlines all
// work normally, and there is nothing to escape.
//
// Run:  node build.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, "entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "MK",
  target: ["es2022"],
  platform: "browser",
  minify: false,
  write: false,
  legalComments: "none",
});

const out = result.outputFiles?.[0];
if (!out) throw new Error("esbuild produced no output");
const bundleJs = out.text;

const shell = readFileSync(join(here, "shell.html"), "utf8");
const marker = "/*__BUNDLE__*/";
if (!shell.includes(marker)) {
  throw new Error(`shell.html is missing the ${marker} placeholder — nothing would be injected`);
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
const html = shell
  .replace(marker, bundleJs)
  .replace(/__BUILD__/g, stamp);

const target = join(here, "index.html");
writeFileSync(target, html, "utf8");

// ⚠️ Report the size so a bundle that silently failed to inline is obvious. A page that builds
// "successfully" at 12 KB has no engine in it.
const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
console.log(`Wrote ${target} (${kb} KB, engine bundle ${(bundleJs.length / 1024).toFixed(1)} KB)`);
