/**
 * Exercises every branch of buildParityReport with synthetic mod lists.
 *
 * Some of these states cannot be produced on disk without a second real SPT install and a
 * mod deliberately held at an old version, so they are constructed directly. Failures print
 * and set a non-zero exit code.
 */
const path = require("path");
const { buildParityReport } = require(path.join(__dirname, "..", "dist-electron", "headless.js"));

const mod = (id, type, version, extra = {}) => ({
  id,
  name: id,
  originalName: id,
  type,
  enabled: true,
  installedManually: false,
  loadOrder: 0,
  version,
  ...extra
});

const mainMods = [
  mod("Fika", "client", "2.3.9"), // required, matches
  mod("SAIN", "client", "4.4.3"), // recommended, DRIFT
  mod("DrakiaXYZ-BigBrain.dll", "client", "1.4.0"), // recommended, missing on headless
  mod("AmandsGraphics", "client", "1.7.0"), // unnecessary, present both
  mod("Kaeno-TraderScrolling.dll", "client", "4.0.0"), // menu risk, present both
  mod("fika-server", "server", "2.0.9"), // server mod, ALSO copied into headless
  mod("WTT-Artem", "server", "3.0.0"), // server mod, main only — correct, no issue
  // Same folder name on BOTH sides. Regression guard: keying rows by name alone let the
  // server row overwrite the client row, so the client plugin rendered as "server only".
  mod("acidphantasm-botplacementsystem", "server", "2.0.19"),
  mod("acidphantasm-botplacementsystem", "client", "2.0.19")
];

const headlessMods = [
  mod("Fika", "client", "2.3.9"),
  mod("SAIN", "client", "4.4.1"), // older than main
  mod("AmandsGraphics", "client", "1.7.0"),
  mod("Kaeno-TraderScrolling.dll", "client", "4.0.0"),
  mod("fika-server", "server", "2.0.9"), // inert here
  mod("SomeOldPlugin", "client", "1.0.0") // headless-only leftover
];

const report = buildParityReport(mainMods, headlessMods);
const byKey = Object.fromEntries(report.rows.map((r) => [r.key, r]));

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${expected}, got ${actual}`}`);
}

console.log("parity engine");
check("Fika aligned, no issue", byKey["client:fika"]?.issue ?? "none", "none");
check("SAIN version drift detected", byKey["client:sain"]?.issue, "version-drift");
check(
  "SAIN keeps both versions",
  `${byKey["client:sain"]?.mainVersion}->${byKey["client:sain"]?.headlessVersion}`,
  "4.4.3->4.4.1"
);
check("BigBrain missing on headless", byKey["client:drakiaxyz-bigbrain"]?.issue, "missing-recommended");
check("server mod copied into headless is flagged", byKey["server:fika-server"]?.issue, "server-mod-in-headless");
check("server mod only in main raises nothing", byKey["server:wtt-artem"]?.issue ?? "none", "none");
check("server mod only in main is server-only", byKey["server:wtt-artem"]?.verdict.klass, "server-only");
check("headless-only leftover flagged", byKey["client:someoldplugin"]?.issue, "headless-only");
check("menu-patching mod flagged even when matched", byKey["client:kaeno-traderscrolling"]?.issue, "unnecessary-menu-risk");
check("cosmetic mod on both sides raises nothing", byKey["client:amandsgraphics"]?.issue ?? "none", "none");

console.log("\nserver/client name collision");
check(
  "server half classified server-only",
  byKey["server:acidphantasm-botplacementsystem"]?.verdict.klass,
  "server-only"
);
check(
  "client half NOT swallowed by the server half",
  byKey["client:acidphantasm-botplacementsystem"]?.verdict.klass,
  "recommended"
);
check("both halves produce their own row", report.rows.filter((r) => r.name === "acidphantasm-botplacementsystem").length, 2);
check(
  "overrides key by mod, not by side",
  byKey["client:acidphantasm-botplacementsystem"]?.modKey,
  "acidphantasm-botplacementsystem"
);

console.log("\ncounts");
check("aligned counts only required/recommended", report.counts.aligned, 1); // Fika only
check("versionDrift", report.counts.versionDrift, 1);
// BigBrain, plus the client half of the collision pair — both genuinely absent on headless.
check("missingOnHeadless", report.counts.missingOnHeadless, 2);
check("headlessOnly includes stray server mod", report.counts.headlessOnly, 2);

console.log("\nordering");
check("most severe issue sorts first", report.rows.find((r) => r.issue)?.issue, "version-drift");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
