#!/usr/bin/env node
//
// scripts/check-i18n-consistency.mjs — validates that every locale file
// in `renderer/locales/` is consistent with the reference (en.json):
//   • file parses as JSON
//   • same key set (no missing keys, no extras)
//   • same value type per key (plural objects stay plural objects, etc.)
//   • no empty string values
//
// Used as both:
//   • Standalone:  npm run i18n:check
//   • Pre-commit:  .githooks/pre-commit (auto-installed via the npm
//                  `prepare` script which sets core.hooksPath)
//
// Exit codes
//   0  every locale file is consistent
//   1  one or more inconsistencies were detected (printed to stderr)
//

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "renderer", "locales");
const REFERENCE = "en";
const LOCALES = ["en", "fr", "de", "es", "it", "zh", "pt", "pt-pt", "pl"];

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function colorize(s, code) {
  return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const red    = (s) => colorize(s, 31);
const green  = (s) => colorize(s, 32);
const yellow = (s) => colorize(s, 33);
const dim    = (s) => colorize(s, 2);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isEmpty(v) {
  if (v === "" || v === null || v === undefined) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "object" && Object.keys(v).length === 0) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// load + parse all locale files
// ─────────────────────────────────────────────────────────────────────

const data = {};
let parseErrors = 0;
for (const code of LOCALES) {
  const p = path.join(LOCALES_DIR, `${code}.json`);
  if (!fs.existsSync(p)) {
    console.error(red(`[i18n-check] missing file: ${path.relative(process.cwd(), p)}`));
    parseErrors++;
    continue;
  }
  try {
    data[code] = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(red(`[i18n-check] ${code}.json: invalid JSON — ${e.message}`));
    parseErrors++;
  }
}
if (parseErrors > 0) {
  console.error(red(`\n[i18n-check] ${parseErrors} file(s) failed to load — fix these first.`));
  process.exit(1);
}

if (!data[REFERENCE]) {
  console.error(red(`[i18n-check] reference locale "${REFERENCE}" failed to load — aborting.`));
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// validate
// ─────────────────────────────────────────────────────────────────────

const refKeys = Object.keys(data[REFERENCE]);
const refSet  = new Set(refKeys);

let errors   = 0;
let warnings = 0;

function err(msg)  { console.error(red("  ✘ ") + msg);    errors++; }
function warn(msg) { console.error(yellow("  ⚠ ") + msg); warnings++; }

// ── reference sanity (en.json itself) ──────────────────────────────
const refIssues = [];
for (const k of refKeys) {
  if (isEmpty(data[REFERENCE][k])) refIssues.push(k);
}
if (refIssues.length) {
  console.error(red(`\n[${REFERENCE}.json] reference locale has empty values:`));
  refIssues.forEach((k) => err(`empty/missing value for "${k}"`));
}

// ── compare every other locale to the reference ────────────────────
for (const code of LOCALES) {
  if (code === REFERENCE) continue;

  const obj  = data[code];
  const keys = new Set(Object.keys(obj));

  const missing = [];
  const empty   = [];
  const types   = [];
  const extra   = [];

  for (const k of refKeys) {
    if (!keys.has(k)) {
      missing.push(k);
      continue;
    }
    if (isEmpty(obj[k])) empty.push(k);
    const refT = typeOf(data[REFERENCE][k]);
    const valT = typeOf(obj[k]);
    if (refT !== valT) {
      types.push({ k, refT, valT });
    }
  }
  for (const k of keys) if (!refSet.has(k)) extra.push(k);

  const total = missing.length + empty.length + types.length + extra.length;
  if (total === 0) continue;

  console.error(red(`\n[${code}.json] ${total} issue(s):`));
  missing.forEach((k) => err(`missing key "${k}"`));
  empty.forEach((k) => err(`empty value for "${k}"`));
  types.forEach((t) =>
    err(`type mismatch for "${t.k}" — expected ${t.refT} (like ${REFERENCE}.json), got ${t.valT}`)
  );
  extra.forEach((k) => err(`extra key "${k}" (not in ${REFERENCE}.json)`));
}

// ─────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────

const summary = `${LOCALES.length} locales × ${refKeys.length} keys`;
if (errors > 0) {
  console.error(red(`\n[i18n-check] FAIL — ${errors} error(s) across ${summary}.`));
  console.error(dim(`Tip: use "npm run i18n:add -- <key> <locale>=… …" to add missing keys.`));
  process.exit(1);
}

if (warnings > 0) {
  console.error(yellow(`[i18n-check] OK with ${warnings} warning(s) — ${summary}.`));
} else {
  console.log(green(`[i18n-check] OK — ${summary}, all consistent.`));
}
process.exit(0);
