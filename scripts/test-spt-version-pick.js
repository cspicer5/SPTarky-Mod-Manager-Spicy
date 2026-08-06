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
