/**
 * Version ordering — one comparator, used everywhere.
 *
 * `compareVersions` decides update checking, server parity, headless parity and the browse
 * pane. Every bug it has produced has been a QUIET one: nothing throws, a difference is simply
 * reported where there is none, or hidden where there is one. So the cases below are the real
 * version strings that caused those, kept as strings rather than as principles.
 *
 * Two rules it deliberately does NOT take from strict semver:
 *
 *   `+build` is treated as a pre-release tag, not as ignorable metadata. Mods here use `+preN`
 *   as a sequence — WTT - Clothing and Gear shipped 1.0.0+pre1 then 1.0.0+pre2 — and semver's
 *   rule makes those the same version, so moving between them is never offered as an update.
 *
 *   Trailing zeroes are padded, so "5.3.11" and "5.3.11.0" are one version. Tyfon.UIFixes.Net
 *   reports one on each machine, and treating that as drift trains people to ignore the marker.
 */
const path = require("path");
const { compareVersions } = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${expected}, got ${actual}`}`);
};
const cmp = (a, b) => compareVersions(a, b);

console.log("\n=== version ordering ===\n");

console.log("ordinary numbering");
{
  check("0.10.0 is above 0.9.0, which text ordering gets wrong", cmp("0.10.0", "0.9.0"), 1);
  check("2.0.0 above 1.9.9", cmp("2.0.0", "1.9.9"), 1);
  check("equal is equal", cmp("1.2.3", "1.2.3"), 0);
  check("a leading v is ignored", cmp("v1.2.3", "1.2.3"), 0);
}

console.log("\ntrailing zeroes are the same version");
{
  // Tyfon.UIFixes.Net, reported as a mismatch in three separate places before this held.
  check("5.3.11 == 5.3.11.0", cmp("5.3.11", "5.3.11.0"), 0);
  check("and the other way round", cmp("5.3.11.0", "5.3.11"), 0);
  check("1.0 == 1.0.0", cmp("1.0", "1.0.0"), 0);
  check("but 5.3.11.1 is genuinely above", cmp("5.3.11.1", "5.3.11"), 1);
}

console.log("\npre-releases are ordered, not discarded");
{
  /*
   * The bug: the old parser split on "." and ran parseInt over each part, so "0-pre1" became 0
   * and every pre-release of one version compared EQUAL. WTT - Clothing and Gear shipped pre1
   * then pre2, and moving between them was never an update.
   */
  check("pre1 is below pre2 with a dash", cmp("1.0.0-pre1", "1.0.0-pre2"), -1);
  check("pre1 is below pre2 with a plus", cmp("1.0.0+pre1", "1.0.0+pre2"), -1);
  check("and pre2 above pre1", cmp("1.0.0+pre2", "1.0.0+pre1"), 1);
  // Numeric, not textual: as text "pre10" sorts below "pre9".
  check("pre10 is above pre9", cmp("1.0.0-pre9", "1.0.0-pre10"), -1);
  check("a pre-release is BELOW its release", cmp("1.0.0-pre2", "1.0.0"), -1);
  check("with a plus too", cmp("1.0.0+pre2", "1.0.0"), -1);
  check("and the release above it", cmp("1.0.0", "1.0.0-pre2"), 1);
  check("identical pre-releases are equal", cmp("1.0.0-pre2", "1.0.0-pre2"), 0);
}

console.log("\nthe renumber that started this");
{
  /*
   * WTT - Clothing and Gear: 1.0.0-pre1, 1.0.0-pre2, then 0.1.3 as the CURRENT release. The
   * comparator is right to call 0.1.3 lower — the numbering really did go backwards — which is
   * exactly why the update check cannot see it and why it is surfaced as information instead.
   */
  check("0.1.3 IS below 1.0.0+pre2, oddly enough", cmp("0.1.3", "1.0.0+pre2"), -1);
  check("so the catalogue build is not an update", cmp("0.1.3", "1.0.0+pre2") > 0, false);
  // ...and that is the signal `checkForgeUpdates` turns into a "catalogue_version_lower" row,
  // rather than reporting nothing at all.
}

console.log("\nrubbish in, no crash out");
{
  check("empty strings compare equal", cmp("", ""), 0);
  check("a non-numeric version does not throw", typeof cmp("banana", "1.0.0"), "number");
  check("and sorts below a real one", cmp("banana", "1.0.0"), -1);
}

console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
