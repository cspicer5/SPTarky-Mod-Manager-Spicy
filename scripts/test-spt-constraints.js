/**
 * SPT version constraint matching.
 *
 * Constraints on Forge are semver ranges and are frequently COMPOUND — HollywoodFX publishes
 * "~4 <4.1.0". Treating the whole string as a single clause parsed that as "~4.1.0" and
 * declared the mod incompatible with 4.0.13, the exact version it targets. That mislabelled
 * its badge and, once the bulk reinstall began honouring SPT versions, skipped it entirely.
 */
const path = require("path");
const { checkSptCompatibility, filterVersionsForSpt } = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));

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

/* ==========================================================================
 * Filtering the browse list's VERSION dropdown.
 *
 * The catalogue's filter[spt_version] filters the MOD, not each version: a mod comes back
 * when any one of its versions matches, and the versions it comes back with are still all of
 * them. Browsing with "only compatible with 4.0.13" therefore listed each matching mod's
 * NEWEST build first — frequently an SPT 4.1.x one, incompatible with the version that had
 * just been asked for. Installing it succeeds; the mod then fails in-game, far from here.
 *
 * Measured against the live catalogue when written: at 4.0.13, BigBrain offered v1.5.0
 * (~4.1.0) as its first choice. It now offers v1.4.0 (~4.0.0).
 * ======================================================================= */
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const mod = (name, versions) => ({ id: 1, name, versions, downloads: 0 });
const ver = (version, sptConstraint) => ({ id: version, version, sptConstraint });

console.log("\nfiltering a mod's version list to one SPT version");
{
  // The reported case, in miniature.
  const bigbrain = mod("BigBrain", [ver("1.5.0", "~4.1.0"), ver("1.4.0", "~4.0.0")]);
  const out = filterVersionsForSpt([bigbrain], "4.0.13");
  eq("the 4.1.x build is dropped", out[0].versions.map((v) => v.version), ["1.4.0"]);
  eq("the mod itself is kept", out.length, 1);
}
{
  // A mod with nothing compatible has nothing installable, so it should not be listed at all.
  const only41 = mod("Only 4.1", [ver("2.0.0", "~4.1.0")]);
  eq("a mod with no compatible build is dropped", filterVersionsForSpt([only41], "4.0.13").length, 0);
}
{
  // "unknown" is not "incompatible". Dropping undeclared versions would hide mods that simply
  // never stated a target, which is common and not an error.
  const undeclared = mod("Undeclared", [ver("1.0.0", undefined)]);
  eq("a version with no constraint is kept", filterVersionsForSpt([undeclared], "4.0.13")[0].versions.length, 1);
}
{
  // Passed through rather than dropped, so it keeps reporting "no version published".
  const none = mod("No versions", []);
  eq("a mod with no versions at all is kept", filterVersionsForSpt([none], "4.0.13").length, 1);
}
{
  // Compound constraints have to survive the filter, not just the badge.
  const hollywood = mod("HollywoodFX", [ver("2.0.0", "~4 <4.1.0"), ver("3.0.0", "~4.1.0")]);
  eq("compound constraint is honoured", filterVersionsForSpt([hollywood], "4.0.13")[0].versions.map((v) => v.version), ["2.0.0"]);
  eq("and the other way at 4.1.2", filterVersionsForSpt([hollywood], "4.1.2")[0].versions.map((v) => v.version), ["3.0.0"]);
}
{
  // The input must not be mutated: the same objects feed the UI's own state.
  const original = mod("Keep", [ver("1.0.0", "~4.1.0"), ver("0.9.0", "~4.0.0")]);
  filterVersionsForSpt([original], "4.0.13");
  eq("the caller's mod is left untouched", original.versions.length, 2);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
