/**
 * SPT version constraint matching.
 *
 * Constraints on Forge are semver ranges and are frequently COMPOUND — HollywoodFX publishes
 * "~4 <4.1.0". Treating the whole string as a single clause parsed that as "~4.1.0" and
 * declared the mod incompatible with 4.0.13, the exact version it targets. That mislabelled
 * its badge and, once the bulk reinstall began honouring SPT versions, skipped it entirely.
 */
const path = require("path");
const { checkSptCompatibility } = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));

let failures = 0;
const check = (constraint, version, expected) => {
  const actual = checkSptCompatibility(constraint, version);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(constraint).padEnd(16)} vs ${String(version).padEnd(9)} -> ${actual}${ok ? "" : `   (wanted ${expected})`}`);
};

console.log("the reported bug: compound constraints");
check("~4 <4.1.0", "4.0.13", "compatible");
check("~4 <4.1.0", "4.0.0", "compatible");
check("~4 <4.1.0", "4.1.0", "incompatible");
check("~4 <4.1.0", "4.1.2", "incompatible");
check("~4 <4.1.0", "3.11.0", "incompatible");
check(">=4.0.0 <4.1.0", "4.0.13", "compatible");
check(">=4.0.0 <4.1.0", "4.1.0", "incompatible");

console.log("\ntilde");
check("~4.0.0", "4.0.13", "compatible");
check("~4.0.0", "4.1.0", "incompatible");
check("~4.0", "4.0.13", "compatible");
// "~4" states no minor, so it accepts any 4.x — which is what makes "~4 <4.1.0" coherent.
check("~4", "4.9.9", "compatible");
check("~4", "5.0.0", "incompatible");
check("~3.11", "4.0.13", "incompatible");
check("~4.0.13", "4.0.12", "incompatible");

console.log("\ncaret");
check("^4.0.0", "4.9.9", "compatible");
check("^4.0.0", "5.0.0", "incompatible");
check("^4.0.5", "4.0.1", "incompatible");

console.log("\ncomparison operators");
check(">=4.0.0", "4.0.13", "compatible");
check(">=4.0.0", "3.9.0", "incompatible");
check(">4.0.13", "4.0.13", "incompatible");
check("<4.1.0", "4.0.13", "compatible");
check("<=4.0.13", "4.0.13", "compatible");

console.log("\nbare versions behave as a prefix match");
check("4.0", "4.0.13", "compatible");
check("4.0.13", "4.0.13", "compatible");
check("4.1", "4.0.13", "incompatible");

console.log("\nnothing to go on");
check(undefined, "4.0.13", "unknown");
check("", "4.0.13", "unknown");
check("~4.0.0", undefined, "unknown");
check("any", "4.0.13", "unknown");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
