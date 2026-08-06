/**
 * Classifies every mod in a real SPT install for headless suitability, and — when a second
 * path is given — reports parity between the two instances.
 *
 * Strictly read-only: it calls the shipping code (scanMods, classifyForHeadless,
 * buildParityReport) rather than reimplementing it, so what it prints is what the app will
 * decide. Nothing is written to either install.
 *
 * Usage:
 *   npm run audit:headless -- "D:\\SPT"
 *   npm run audit:headless -- "D:\\SPT" "D:\\SPT_Headless"
 */
const path = require("path");
const fs = require("fs");

const dist = path.join(__dirname, "..", "dist-electron");
const { scanMods, resolveSptInstance } = require(path.join(dist, "modManager.js"));
const { classifyForHeadless, buildParityReport, resolveHeadlessInstance, normaliseModKey, buildServerCounterpartIndex } =
  require(path.join(dist, "headless.js"));

const [mainArg, headlessArg] = process.argv.slice(2);
if (!mainArg) {
  console.error('Usage: npm run audit:headless -- "D:\\SPT" ["D:\\SPT_Headless"]');
  process.exit(1);
}

/** Forge category / Fika flag for the installed mods, from the pre-shutdown harvest. */
function loadForgeHints() {
  const file = path.join(__dirname, "..", "data", "forge-directory.json");
  if (!fs.existsSync(file)) return {};
  const { mods } = JSON.parse(fs.readFileSync(file, "utf-8"));
  const byKey = {};
  for (const m of mods) {
    if (!m.name) continue;
    byKey[normaliseModKey(m.name)] = { category: m.category, fikaCompatible: m.fikaCompatible };
    if (m.guid) byKey[normaliseModKey(m.guid)] = { category: m.category, fikaCompatible: m.fikaCompatible };
  }
  return byKey;
}

const resolved = resolveSptInstance(mainArg);
if (!resolved) {
  console.error(`No SPT instance found at ${mainArg}`);
  process.exit(1);
}
const { clientRoot, serverRoot } = resolved.instance;
const forgeHints = loadForgeHints();

const mainMods = scanMods(clientRoot, serverRoot);

console.log("=".repeat(76));
console.log("HEADLESS SUITABILITY AUDIT");
console.log("=".repeat(76));
console.log(`main client : ${clientRoot}`);
console.log(`main server : ${serverRoot}`);
console.log(`mods found  : ${mainMods.length}`);
console.log("");

const serverCounterparts = buildServerCounterpartIndex(mainMods);
const verdictOf = (mod) =>
  classifyForHeadless(mod, {
    forge: forgeHints[normaliseModKey(mod.id)] || forgeHints[normaliseModKey(mod.originalName)],
    serverCounterparts
  });

const buckets = {};
for (const mod of mainMods) {
  (buckets[verdictOf(mod).klass] ??= []).push({ mod, verdict: verdictOf(mod) });
}

const ORDER = ["required", "recommended", "unknown", "optional", "unnecessary", "server-only"];
for (const klass of ORDER) {
  const rows = buckets[klass];
  if (!rows?.length) continue;
  console.log("-".repeat(76));
  console.log(`${klass.toUpperCase()}  (${rows.length})`);
  console.log("-".repeat(76));
  for (const { mod, verdict } of rows.sort((a, b) => a.mod.name.localeCompare(b.mod.name))) {
    const flags = [verdict.source, verdict.menuRisk ? "menu-risk" : null].filter(Boolean).join(",");
    console.log(`  ${mod.name.padEnd(38).slice(0, 38)} ${(mod.version || "-").padEnd(10)} [${flags}]`);
  }
  console.log("");
}

// The number that matters: how much of the client-side list the ruleset actually decides.
const clientSide = mainMods.filter((m) => m.type !== "server");
const decided = clientSide.filter((m) => verdictOf(m).klass !== "unknown");
console.log("-".repeat(76));
console.log("COVERAGE");
console.log("-".repeat(76));
console.log(`  server mods (structural, need no judgement) : ${mainMods.length - clientSide.length}`);
console.log(`  client plugins                             : ${clientSide.length}`);
console.log(
  `  of those, classified                       : ${decided.length}  (${((100 * decided.length) / Math.max(clientSide.length, 1)).toFixed(0)}%)`
);
console.log(`  left to the user to decide                 : ${clientSide.length - decided.length}`);
console.log("");

if (!headlessArg) {
  console.log("No headless path given — skipping the parity report.");
  process.exit(0);
}

const hl = resolveHeadlessInstance(headlessArg);
if (!hl) {
  console.error(`No headless client found at ${headlessArg} (expected FikaHeadlessManager.exe).`);
  process.exit(1);
}

const headlessMods = scanMods(hl.instance.root, hl.instance.root);
const forgeByKey = {};
for (const m of [...mainMods, ...headlessMods]) {
  const hint = forgeHints[normaliseModKey(m.id)] || forgeHints[normaliseModKey(m.originalName)];
  if (hint) forgeByKey[normaliseModKey(m.id)] = hint;
}

const report = buildParityReport(mainMods, headlessMods, { forge: forgeByKey });

console.log("=".repeat(76));
console.log(`PARITY  —  ${hl.instance.root}`);
console.log("=".repeat(76));
console.log(`  aligned              : ${report.counts.aligned}`);
console.log(`  version drift        : ${report.counts.versionDrift}`);
console.log(`  missing on headless  : ${report.counts.missingOnHeadless}`);
console.log(`  headless-only        : ${report.counts.headlessOnly}`);
console.log(`  needs review         : ${report.counts.needsReview}`);
console.log("");

for (const row of report.rows.filter((r) => r.issue)) {
  console.log(`  [${row.issue}] ${row.name}`);
  if (row.detail) console.log(`      ${row.detail}`);
}
