/**
 * Choosing which published version to install for a given SPT version.
 *
 * A mod's newest release is often built for a NEWER SPT than the one installed. Taking
 * versions[0] unconditionally is what made a bulk reinstall targeting SPT 4.0.13 fetch
 * DynamicMaps 1.2.0, which does not run on it.
 */
const path = require("path");
const { pickForgeVersionForSpt } = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

// Newest first, as Forge returns them.
const DYNAMIC_MAPS = [
  { version: "1.2.0", link: "l-120", sptConstraint: "~4.1.0" },
  { version: "1.1.3", link: "l-113", sptConstraint: "~4.0.0" },
  { version: "1.0.0", link: "l-100", sptConstraint: "~3.9.0" }
];

console.log("the reported bug: SPT 4.0.13 must not get 1.2.0");
check("picks the 4.0-compatible build", pickForgeVersionForSpt(DYNAMIC_MAPS, "4.0.13")?.version, "1.1.3");
check("on 4.1.2 it picks the newest", pickForgeVersionForSpt(DYNAMIC_MAPS, "4.1.2")?.version, "1.2.0");
check("on 3.9.0 it goes back further", pickForgeVersionForSpt(DYNAMIC_MAPS, "3.9.0")?.version, "1.0.0");

console.log("\nno SPT version given — behave as before");
check("takes the newest", pickForgeVersionForSpt(DYNAMIC_MAPS, undefined)?.version, "1.2.0");

console.log("\nversions without a constraint");
const MIXED = [
  { version: "2.0.0", link: "a" }, // no constraint — not a promise
  { version: "1.5.0", link: "b", sptConstraint: "~4.0.0" }
];
// An explicit match beats a version that simply says nothing about compatibility.
check("prefers an explicit match over an unknown", pickForgeVersionForSpt(MIXED, "4.0.13")?.version, "1.5.0");
check("falls back to unknown when nothing matches", pickForgeVersionForSpt(MIXED, "9.9.9")?.version, "2.0.0");

console.log("\nan OLD build that declares nothing is not a fallback (UnityToolkit, 2026-11-20)");
// The real version list from sp-mod.com, newest first. 2.0.2 declares exactly "4.1.5"; nothing
// declares 4.1.6; 1.1.0 (January 2025) declares nothing at all.
const UNITY_TOOLKIT = [
  { version: "2.0.2", link: "u-202", sptConstraint: "4.1.5" },
  { version: "2.0.1", link: "u-201", sptConstraint: ">=4.0.0 <4.1.0" },
  { version: "2.0.0", link: "u-200", sptConstraint: ">=4.0.0 <4.1.0" },
  { version: "1.2.0", link: "u-120", sptConstraint: "~3.10.0" },
  { version: "1.1.0", link: "u-110" },
  { version: "1.0.1", link: "u-101" },
  { version: "1.0.0", link: "u-100" }
];
// The bug: this returned 1.1.0, so the update check called 1.1.0 "the catalogue's current build"
// and a bulk reinstall for 4.1.6 would have downgraded 2.0.2 to it.
check("on 4.1.6 nothing is picked, not 1.1.0", pickForgeVersionForSpt(UNITY_TOOLKIT, "4.1.6"), undefined);
check("on 4.1.5 the pinned build is picked", pickForgeVersionForSpt(UNITY_TOOLKIT, "4.1.5")?.version, "2.0.2");
check("on 4.0.13 the 4.0 build is picked", pickForgeVersionForSpt(UNITY_TOOLKIT, "4.0.13")?.version, "2.0.1");
// Order must not matter: one endpoint lists versions OLDEST-first.
check("the same answer from an oldest-first list", pickForgeVersionForSpt([...UNITY_TOOLKIT].reverse(), "4.1.6"), undefined);
// The case the fallback exists for still works: a NEWER build that stopped declaring.
const STOPPED_DECLARING = [
  { version: "3.0.0", link: "s-300" },
  { version: "2.0.0", link: "s-200", sptConstraint: "~4.0.0" }
];
check("a newer build that declares nothing is still a fallback", pickForgeVersionForSpt(STOPPED_DECLARING, "4.1.6")?.version, "3.0.0");
check("a mod that never declares anything still gets its newest", pickForgeVersionForSpt([{ version: "1.0.0", link: "n" }], "4.1.6")?.version, "1.0.0");
// A wildcard is as good as declaring nothing — it must not become the bar the fallback has to
// clear. Shipped wrong in 1.5.2-dev.1: this returned nothing on every SPT version.
const WILDCARD_NEWEST = [
  { version: "2.0.0", link: "w-200", sptConstraint: "*" },
  { version: "1.0.0", link: "w-100", sptConstraint: "~3.9.0" }
];
check("a newest build declaring * is still a fallback", pickForgeVersionForSpt(WILDCARD_NEWEST, "4.1.6")?.version, "2.0.0");
check(
  "an OLD build declaring * is not",
  pickForgeVersionForSpt([{ version: "2.0.2", link: "a", sptConstraint: "4.1.5" }, { version: "1.0.0", link: "b", sptConstraint: "*" }], "4.1.6"),
  undefined
);

console.log("\naccepting a build on an SPT the author did not declare");
{
  const { acceptanceApplies, acceptSptIncompatibility, unacceptSptIncompatibility, loadSptAcceptances } = require(path.join(
    __dirname,
    "..",
    "dist-electron",
    "modManager.js"
  ));
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-accept-"));
  acceptSptIncompatibility(dir, "UnityToolkit", "v2.0.2", "4.1.6");
  const entry = loadSptAcceptances(dir).UnityToolkit;
  check("it is stored, with the leading v dropped", entry && entry.version, "2.0.2");
  check("it applies to the same build on the same SPT", acceptanceApplies(entry, "2.0.2", "4.1.6"), true);
  // It lapses on its own: a new build or a new SPT is a new question.
  check("a different installed build is not covered", acceptanceApplies(entry, "2.0.3", "4.1.6"), false);
  check("a different SPT is not covered", acceptanceApplies(entry, "2.0.2", "4.1.7"), false);
  check("an unknown installed version is not covered", acceptanceApplies(entry, undefined, "4.1.6"), false);
  check("no acceptance, nothing applies", acceptanceApplies(undefined, "2.0.2", "4.1.6"), false);
  check("undo removes it", unacceptSptIncompatibility(dir, "UnityToolkit"), true);
  check("and it is gone", loadSptAcceptances(dir).UnityToolkit, undefined);
  check("undoing twice says so", unacceptSptIncompatibility(dir, "UnityToolkit"), false);
  fs.writeFileSync(path.join(dir, ".spt-mod-manager-spt-accepted.json"), "not json");
  check("a corrupt file reads as nothing accepted", JSON.stringify(loadSptAcceptances(dir)), "{}");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\nnothing suitable at all");
const ONLY_NEW = [{ version: "3.0.0", link: "x", sptConstraint: "~5.0.0" }];
// Returning nothing is correct: the caller reports it and leaves the installed copy alone,
// rather than installing something that cannot load.
check("returns nothing rather than something broken", pickForgeVersionForSpt(ONLY_NEW, "4.0.13"), undefined);

console.log("\nedge cases");
check("empty list", pickForgeVersionForSpt([], "4.0.13"), undefined);
check("undefined list", pickForgeVersionForSpt(undefined, "4.0.13"), undefined);
check("ignores versions with no download link", pickForgeVersionForSpt([{ version: "1.0.0", sptConstraint: "~4.0.0" }], "4.0.13"), undefined);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
