// Propagates the version from package.json to every other file that hardcodes
// it (Cargo.toml × 4, Cargo.lock × 2, package-lock.json, tauri.conf.json).
// Run after editing package.json's "version". The SettingsModal version label
// reads getVersion() at runtime, so it needs no sync entry.
//
// The changelog block in SettingsModal.tsx is intentionally not touched — the
// release notes are human-written copy, not a derived value.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json has an invalid version: '${version}'`);
  process.exit(1);
}
console.log(`Syncing version to ${version}\n`);

let touched = 0;
let unchanged = 0;

function patch(relPath, pattern, replacement, { expect } = {}) {
  const fp = join(repo, relPath);
  const before = readFileSync(fp, "utf8");
  const matches = before.match(pattern instanceof RegExp && pattern.flags.includes("g")
    ? pattern
    : new RegExp(pattern.source, pattern.flags + "g"));
  const count = matches ? matches.length : 0;
  if (count === 0) {
    console.error(`  ${relPath}: no match for ${pattern}`);
    process.exit(1);
  }
  if (expect !== undefined && count !== expect) {
    console.error(`  ${relPath}: expected ${expect} match(es), found ${count}`);
    process.exit(1);
  }
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.log(`  ${relPath}: already at ${version}`);
    unchanged++;
  } else {
    writeFileSync(fp, after);
    console.log(`  ${relPath}: ${count} match(es) updated`);
    touched++;
  }
}

patch(
  "package-lock.json",
  /("name":\s*"noten",\s*"version":\s*)"[^"]+"/g,
  `$1"${version}"`,
  { expect: 2 },
);

patch(
  "src-tauri/tauri.conf.json",
  /^(\s*"version":\s*)"[^"]+"/m,
  `$1"${version}"`,
);

for (const f of [
  "src-tauri/Cargo.toml",
  "bootstrapper/Cargo.toml",
  "maintenance-helper/Cargo.toml",
  "noten-splash-ui/Cargo.toml",
]) {
  patch(f, /(\[package\][\s\S]*?\nversion = )"[^"]+"/, `$1"${version}"`);
}

for (const name of ["noten-setup", "maintenance-helper", "noten-splash-ui"]) {
  patch(
    "Cargo.lock",
    new RegExp(`(name = "${name}"\\r?\\nversion = )"[^"]+"`),
    `$1"${version}"`,
  );
}

patch(
  "src-tauri/Cargo.lock",
  /(name = "noten"\r?\nversion = )"[^"]+"/,
  `$1"${version}"`,
);

console.log(`\nDone. ${touched} file(s) updated, ${unchanged} already in sync.`);
console.log("Remember to update the changelog block in SettingsModal.tsx (Korean + English).");
