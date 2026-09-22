#!/usr/bin/env node
/**
 * Patch @1claw/sdk (and similar) ESM dist/ for Node runtime containers.
 * Usage: node fix-esm-imports.mjs [distDir ...]
 * With no args, fixes common install locations under /app and /opt.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMPORT_RE =
  /\b(from|export\s+\*?\s*(?:\{[^}]*\}\s*)?from)\s+(["'])(\.\.?[^"']+)\2/g;

function fixContent(filePath, content) {
  const fromDir = path.dirname(filePath);
  return content.replace(IMPORT_RE, (match, keyword, quote, spec) => {
    if (spec.endsWith(".js") || spec.endsWith(".json")) return match;
    if (fs.existsSync(path.join(fromDir, spec + ".js"))) {
      return `${keyword} ${quote}${spec}.js${quote}`;
    }
    if (fs.existsSync(path.join(fromDir, spec, "index.js"))) {
      return `${keyword} ${quote}${spec}/index.js${quote}`;
    }
    return match;
  });
}

function walk(dir) {
  if (!fs.existsSync(dir)) return 0;
  let changed = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) changed += walk(p);
    else if (ent.name.endsWith(".js")) {
      const orig = fs.readFileSync(p, "utf8");
      const fixed = fixContent(p, orig);
      if (fixed !== orig) {
        fs.writeFileSync(p, fixed);
        changed += 1;
      }
    }
  }
  return changed;
}

function fixTree(root) {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist)) return 0;
  const n = walk(dist);
  if (n > 0) console.log(`fix-esm-imports: patched ${n} file(s) in ${dist}`);
  return n;
}

/** Fail the build if any relative ESM import still lacks a resolvable .js target. */
function verifyTree(root) {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist)) {
    console.error(`fix-esm-imports: verify failed — missing dist at ${root}`);
    return false;
  }

  const REL_IMPORT_RE =
    /\b(?:from|export\s+\*?\s*(?:\{[^}]*\}\s*)?from)\s+(["'])(\.\.?[^"']+)\1/g;
  let ok = true;

  function verifyFile(filePath) {
    const fromDir = path.dirname(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    for (const match of content.matchAll(REL_IMPORT_RE)) {
      const spec = match[2];
      if (spec.endsWith(".js") || spec.endsWith(".json")) continue;
      const asJs = path.join(fromDir, spec + ".js");
      const asIndex = path.join(fromDir, spec, "index.js");
      if (!fs.existsSync(asJs) && !fs.existsSync(asIndex)) {
        console.error(
          `fix-esm-imports: unresolved import "${spec}" in ${filePath}`,
        );
        ok = false;
      }
    }
  }

  function verifyWalk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) verifyWalk(p);
      else if (ent.name.endsWith(".js")) verifyFile(p);
    }
  }

  verifyWalk(dist);
  if (ok) console.log(`fix-esm-imports: verified ${dist}`);
  return ok;
}

const defaultRoots = [
  "/app/workspace/node_modules/@1claw/sdk",
  "/opt/1claw-hermes/node_modules/@1claw/sdk",
];

const args = process.argv.slice(2);
const targets =
  args.length > 0
    ? args.map((a) => (a.endsWith("/dist") ? path.dirname(a) : a))
    : defaultRoots;

let total = 0;
let verified = 0;
const existingTargets = targets.filter((root) => fs.existsSync(root));
for (const root of existingTargets) {
  total += fixTree(root);
  if (verifyTree(root)) verified += 1;
}
if (total === 0 && args.length === 0) {
  console.log("fix-esm-imports: no @1claw/sdk dist trees needed patching");
}
if (existingTargets.length > 0 && verified !== existingTargets.length) {
  process.exit(1);
}
