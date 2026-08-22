/**
 * Are the installed addons out of date — and if not, why not?
 *
 * An addon is not a mod. It is built against a PARENT VERSION, so "is there a newer one" is the
 * wrong question on its own: the newest build of an addon frequently wants a parent you do not
 * have. Offering it anyway is the same fault that shipped once in preset sync — installing
 * something built for a version nobody is running.
 *
 * The statuses below exist because the interesting cases are all about that relationship, and
 * each maps to a different thing for a person to do (or not do):
 *
 *   update              take it
 *   needs-parent-update update the PARENT, then take it
 *   no-build-for-parent probably folded into the parent — check before reinstalling
 *   delisted            withdrawn or absorbed; the ledger entry may be dead weight
 *
 * Measured on the reference install when this was written: two addons at `needs-parent-update`
 * (NVG support 1.1.0 wants parent ~3.0.0, COTI is 2.0.0) and six up to date.
 */
const path = require("path");
const { checkAddonUpdates } = require(path.join(__dirname, "..", "dist-electron", "addons.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const record = (over) => ({
  name: over.name ?? "A patch",
  forgeAddonId: "forgeAddonId" in over ? over.forgeAddonId : 100,
  version: over.version ?? "1.0.0",
  parentName: over.parentName ?? "ParentMod",
  parentType: over.parentType ?? "client",
  installedAt: "2026-08-01T00:00:00.000Z",
  source: "forge",
  folders: [],
  mergedIntoParent: true,
  ...over
});

const addon = (over) => ({
  id: over.id ?? 100,
  name: over.name ?? "A patch",
  detailUrl: "https://example/addon/100",
  versions: over.versions ?? [],
  ...over
});

const v = (version, modConstraint) => ({ version, link: `https://example/${version}.zip`, modConstraint });

// The install: one parent at a known version, plus a switch for "not installed at all".
const parentAt = (version) => ({
  versionOf: () => version,
  installed: () => true
});
const noParent = { versionOf: () => undefined, installed: () => false };

const run = (rec, cat, env) => checkAddonUpdates([rec], cat, env.versionOf, env.installed)[0];

console.log("\n=== addon updates, judged against the PARENT ===\n");

console.log("a newer build that fits");
{
  const row = run(
    record({ version: "1.0.0" }),
    [addon({ versions: [v("1.1.0", "~2.0.0"), v("1.0.0", "~2.0.0")] })],
    parentAt("2.0.0")
  );
  check("is an update", row.status, "update");
  check("naming the build to take", row.availableVersion, "1.1.0");
  check("with somewhere to get it", Boolean(row.downloadLink), true);
}

console.log("\na newer build that wants a NEWER PARENT");
{
  /*
   * The case from the reference install: NVG support 1.1.0 requires parent ~3.0.0 while COTI is
   * 2.0.0. Offering it would install an addon built for a mod version that is not there.
   */
  const row = run(
    record({ version: "1.0.0", parentName: "LennoxP90-COTI" }),
    [addon({ versions: [v("1.1.0", "~3.0.0"), v("1.0.0", "~2.0.0")] })],
    parentAt("2.0.0")
  );
  check("is NOT offered as an update", row.status, "needs-parent-update");
  check("and carries no download", row.downloadLink, undefined);
  check("but names the build being held back", row.blockedVersion, "1.1.0");
  check("and what it needs", row.requiresParent, "~3.0.0");
  check("saying which mod to update", /Update LennoxP90-COTI first/.test(row.detail), true);
}

console.log("\nalready on the best build for this parent");
{
  const row = run(
    record({ version: "1.0.0" }),
    [addon({ versions: [v("1.0.0", "~2.0.0")] })],
    parentAt("2.0.0")
  );
  check("is up to date", row.status, "up-to-date");
  check("with nothing to install", row.availableVersion, undefined);
}

console.log("\nthe parent has outgrown every build");
{
  // What "the addon was folded into the mod" looks like from out here: it is still listed, but
  // nothing it offers is built for the parent any more.
  const row = run(
    record({ version: "1.0.0", parentName: "WTT-CAG" }),
    [addon({ versions: [v("1.0.0", "~1.0.0")] })],
    parentAt("3.5.0")
  );
  check("is flagged as having no build", row.status, "no-build-for-parent");
  check("and says what that usually means", /part of WTT-CAG itself now/.test(row.detail), true);
}

console.log("\na WILDCARD constraint fits anything");
{
  /*
   * `*` means "any parent version", but the range parser answers "unknown" for it rather than
   * "compatible". A build constrained that way matched neither branch of the picker, so the
   * addon came back as having no build at all — and "nothing fits your parent" is read as
   * evidence the patch was absorbed. CAG BRNVG patch, which fits anything, was reported as
   * folded into WTT-CAG and due for removal.
   */
  for (const wildcard of ["*", "x", "any", "", "   "]) {
    const row = run(
      record({ version: "1.0.0" }),
      [addon({ versions: [v("1.0.0", wildcard)] })],
      parentAt("0.1.3")
    );
    check(`constraint ${JSON.stringify(wildcard)} is not "no build"`, row.status, "up-to-date");
  }
}

console.log("\nno longer in the catalogue at all");
{
  // Withdrawn, or absorbed into the parent and taken down. There is no signal that tells those
  // apart, so it says so as the two possibilities rather than picking one.
  const row = run(record({ forgeAddonId: 999, parentName: "SomeMod" }), [addon({ id: 100 })], parentAt("2.0.0"));
  check("is delisted", row.status, "delisted");
  check("naming both possibilities", /withdrawn or folded into SomeMod/.test(row.detail), true);
}

console.log("\nthe awkward ones");
{
  const detached = run(record({}), [addon({ isDetached: true, versions: [v("1.0.0", "*")] })], parentAt("2.0.0"));
  check("a detached addon says so", detached.status, "detached");

  const orphan = run(record({ parentName: "GoneMod" }), [addon({ versions: [v("1.0.0", "*")] })], noParent);
  check("a missing parent is its own answer", orphan.status, "parent-missing");
  check("and names it", /GoneMod is not installed here/.test(orphan.detail), true);

  // Installed from a file: no id, so there is nothing to look up. Never guessed at by name.
  const byHand = run(record({ forgeAddonId: undefined }), [addon({ versions: [v("2.0.0", "*")] })], parentAt("2.0.0"));
  check("a file install cannot be checked", byHand.status, "unknown");
  check("and is not offered an update", byHand.availableVersion, undefined);
}

console.log("\nwhen the parent's version is unknown");
{
  // The fit cannot be verified, so it is taken but SAID to be unverified rather than presented
  // as a checked match.
  const row = run(
    record({ version: "1.0.0" }),
    [addon({ versions: [v("1.1.0", "~2.0.0")] })],
    { versionOf: () => undefined, installed: () => true }
  );
  check("an update is still offered", row.status, "update");
  check("but the fit is not claimed", /declares no parent version|is not stated/.test(row.detail), true);
}

console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
