/**
 * Own-folder addons: updating one, and linking one by hand.
 *
 * Found on the SPT 4.1 install (2026-11-20). ORBIT's Fika addon lives in its OWN folder,
 * `Orbit.Fika`. Updating it in-app (1.0.0 -> 1.2.0) broke every record of what it is:
 *
 *  - the install counted only folders that did not exist before, saw none, and recorded the
 *    addon as merged into ORBIT with no folders and no files
 *  - it then "restored" Orbit.Fika's version to 1.0.0, treating the addon's own folder as an
 *    unrelated mod it had clobbered
 *  - the archive installer rebuilt the row from scratch, dropping `addonOf`
 *
 * So the folder went back to being a mod, was fuzzy-matched to an unrelated catalogue mod
 * ("Fika Hub"), and the addon had since been delisted, so reinstalling could not repair it.
 *
 * Everything happens in a temp directory; no real install is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const A = require(path.join(dist, "addons.js"));
const M = require(path.join(dist, "modManager.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};
const json = (v) => JSON.stringify(v);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-addon-link-"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));

const ORBIT = { id: "ORBIT", type: "client" };
const ORBIT_FIKA = { id: "Orbit.Fika", type: "client" };

/* ------------------------------------------------- which folders are the addon's */
console.log("\nwhich folders an addon install produced AS THE ADDON");
{
  const marks = { "client:orbit.fika": { addonOf: "ORBIT", addonOfType: "client", forgeAddonId: 123 } };

  check(
    "first install: a new folder is the addon's",
    json(A.addonOwnFolders({ parent: ORBIT, added: [ORBIT_FIKA], rewritten: [], priorMarks: {} })),
    json([ORBIT_FIKA])
  );
  // THE BUG: on an update nothing is new, so the addon was recorded as merged into its parent.
  check(
    "update: the existing folder, already marked as this addon, is still the addon's",
    json(A.addonOwnFolders({ parent: ORBIT, added: [], rewritten: [ORBIT_FIKA], priorMarks: marks, forgeAddonId: 123 })),
    json([ORBIT_FIKA])
  );
  check(
    "update: the previous ledger record listing the folder is evidence too",
    json(
      A.addonOwnFolders({
        parent: ORBIT,
        added: [],
        rewritten: [ORBIT_FIKA],
        priorMarks: {},
        priorRecord: { folders: [ORBIT_FIKA] }
      })
    ),
    json([ORBIT_FIKA])
  );
  // Without evidence, a rewritten folder is something else the archive touched — a bundled copy
  // of a dependency, say. Claiming it would turn a real mod into an addon.
  check(
    "a rewritten folder with no evidence is NOT claimed",
    json(A.addonOwnFolders({ parent: ORBIT, added: [], rewritten: [{ id: "UnityToolkit", type: "client" }], priorMarks: {} })),
    json([])
  );
  check(
    "the parent is never its own addon, even when rewritten",
    json(A.addonOwnFolders({ parent: ORBIT, added: [ORBIT], rewritten: [ORBIT], priorMarks: { "client:orbit": { addonOf: "ORBIT" } } })),
    json([])
  );
  check(
    "a folder marked as a DIFFERENT addon of the same parent is not claimed",
    json(A.addonOwnFolders({ parent: ORBIT, added: [], rewritten: [ORBIT_FIKA], priorMarks: marks, forgeAddonId: 999 })),
    json([])
  );
  check(
    "a folder marked as an addon of a different parent is not claimed",
    json(A.addonOwnFolders({ parent: { id: "SAIN", type: "client" }, added: [], rewritten: [ORBIT_FIKA], priorMarks: marks })),
    json([])
  );
  check(
    "a file or GitHub install has no catalogue id, and the parent's mark still counts",
    json(A.addonOwnFolders({ parent: ORBIT, added: [], rewritten: [ORBIT_FIKA], priorMarks: marks })),
    json([ORBIT_FIKA])
  );
}

/* --------------------------------------------- the whole update, end to end */
console.log("\nupdating an own-folder addon, through the real registry functions");
{
  const install = path.join(root, "update");
  fs.mkdirSync(install, { recursive: true });
  const registryPath = path.join(install, ".spt-mod-manager-registry.json");

  const before = [
    { id: "ORBIT", displayName: "ORBIT", type: "client", installedAt: "2026-09-07T18:00:00.000Z", source: "archive-install", installedVersion: "3.1.1", versionOrigin: "forge", versionEvidence: "Forge: ORBIT 3.0 3.1.1" },
    { id: "Orbit.Fika", displayName: "Orbit.Fika", type: "client", installedAt: "2026-09-07T18:23:26.438Z", source: "archive-install", installedVersion: "1.0.0", versionOrigin: "forge", versionEvidence: "Forge: ORBIT - Fika Addon 1.0.0", addonOf: "ORBIT", addonOfType: "client", forgeAddonId: 123 }
  ];
  writeJson(registryPath, before);
  const foldersBefore = new Set(["client:ORBIT", "client:Orbit.Fika"]);
  const versionsBefore = A.snapshotVersions(registryPath);
  const priorMarks = A.snapshotAddonMarks(registryPath);

  // What the archive installer does to the row: rebuilt from scratch, with no addon fields.
  // carryAddonMark is what addToRegistry now runs on every write.
  const fresh = { id: "Orbit.Fika", displayName: "Orbit.Fika", type: "client", installedAt: "2026-10-27T18:56:37.485Z", source: "archive-install", installedVersion: "1.2.0", versionOrigin: "forge", versionEvidence: "Forge: ORBIT - Fika Addon 1.2.0" };
  const rewrittenRow = M.carryAddonMark(before[1], fresh);
  check("rewriting the row keeps addonOf", rewrittenRow.addonOf, "ORBIT");
  check("rewriting the row keeps the addon's catalogue id", rewrittenRow.forgeAddonId, 123);
  writeJson(registryPath, [before[0], rewrittenRow]);

  const rewritten = A.foldersRewrittenSince(registryPath, versionsBefore, foldersBefore);
  check("the rewritten folder is seen as written by this install", json(rewritten), json([ORBIT_FIKA]));

  const own = A.addonOwnFolders({ parent: ORBIT, added: [], rewritten, priorMarks, forgeAddonId: 123 });
  check("it is recognised as the addon's own folder", json(own), json([ORBIT_FIKA]));

  // Falsification: the OLD call, with nothing kept, is exactly what reverted 1.2.0 to 1.0.0.
  const scratch = path.join(install, "old-behaviour.json");
  fs.copyFileSync(registryPath, scratch);
  A.restoreClobberedVersions(scratch, versionsBefore);
  check("(the old behaviour really did revert the addon to 1.0.0)", readJson(scratch)[1].installedVersion, "1.0.0");

  A.restoreClobberedVersions(registryPath, versionsBefore, new Set(own.map((f) => `${f.type}:${f.id.toLowerCase()}`)));
  const after = readJson(registryPath);
  check("the addon keeps the version it was just updated to", after[1].installedVersion, "1.2.0");
  check("and its fresh install stamp", after[1].installedAt, "2026-10-27T18:56:37.485Z");
  check("the addon stays an addon", after[1].addonOf, "ORBIT");
  check("so it is NOT recorded as merged into its parent", own.length === 0, false);
}

/* ------------------------------------------------ rows rewritten by an install */
console.log("\nwhich existing rows an install rewrote");
{
  const install = path.join(root, "rewritten");
  fs.mkdirSync(install, { recursive: true });
  const registryPath = path.join(install, ".spt-mod-manager-registry.json");
  writeJson(registryPath, [
    { id: "Kept", type: "client", installedAt: "2026-01-01T00:00:00.000Z" },
    { id: "Touched", type: "client", installedAt: "2026-01-01T00:00:00.000Z" }
  ]);
  const versionsBefore = A.snapshotVersions(registryPath);
  // "Untracked" was on disk before but had no row; "Brand-new" did not exist at all.
  const foldersBefore = new Set(["client:Kept", "client:Touched", "client:Untracked"]);
  writeJson(registryPath, [
    { id: "Kept", type: "client", installedAt: "2026-01-01T00:00:00.000Z" },
    { id: "Touched", type: "client", installedAt: "2026-11-20T00:00:00.000Z" },
    { id: "Untracked", type: "client", installedAt: "2026-11-20T00:00:00.000Z" },
    { id: "Brand-new", type: "client", installedAt: "2026-11-20T00:00:00.000Z" }
  ]);
  const ids = A.foldersRewrittenSince(registryPath, versionsBefore, foldersBefore).map((f) => f.id).sort();
  check("a restamped row and a newly tracked existing folder count; untouched and new do not", json(ids), json(["Touched", "Untracked"]));
}

/* --------------------------------------------------- addon marks survive rewrites */
console.log("\nan addon mark survives a row being rewritten");
{
  const prev = { id: "X", type: "client", addonOf: "P", addonOfType: "client", forgeAddonId: 7, addonParentConstraint: "~1.0.0" };
  const incoming = { id: "X", type: "client", installedVersion: "2.0.0" };
  const out = M.carryAddonMark(prev, incoming);
  check("all four addon fields are carried", json([out.addonOf, out.addonOfType, out.forgeAddonId, out.addonParentConstraint]), json(["P", "client", 7, "~1.0.0"]));
  check("the new row's own fields win", out.installedVersion, "2.0.0");
  check("a row stating its own addon fields is left alone", M.carryAddonMark(prev, { ...incoming, addonOf: "Q" }).addonOf, "Q");
  check("a row with no previous mark is untouched", M.carryAddonMark({ id: "X", type: "client" }, incoming), incoming);
  check("no previous row is fine", M.carryAddonMark(undefined, incoming), incoming);
}

/* ---------------------------------------------------- which addons to offer */
console.log("\nwhich recorded addons a mod-looking folder could really be");
{
  // The 4.1 install's ledger, trimmed to the shapes that matter.
  const ledger = [
    { forgeAddonId: 123, name: "ORBIT - Fika Addon", version: "1.2.0", parentName: "ORBIT", parentType: "client", folders: [], mergedIntoParent: true, parentFiles: [], parentFileMarks: [] },
    { forgeAddonId: 39, name: "Climbable Ladders - Fika sync", parentName: "tarkin-ladders", parentType: "client", folders: [], mergedIntoParent: true, parentFiles: ["tarkin.ladders.fika.dll"] },
    { forgeAddonId: 128, name: "Quick Sell (4.1.x)", parentName: "SwiftXP.ShowMeTheMoney.dll", parentType: "client", folders: [{ id: "SwiftXP.SPT.ShowMeTheMoney.QuickSell.dll", type: "client" }], mergedIntoParent: false, parentFiles: [] },
    { forgeAddonId: 50, name: "Addon of something not installed", parentName: "Gone", parentType: "client", folders: [], mergedIntoParent: true, parentFiles: [] },
    { forgeAddonId: 60, name: "Already lives here", parentName: "ORBIT", parentType: "client", folders: [ORBIT_FIKA], mergedIntoParent: false, parentFiles: ["x.dll"] }
  ];
  const installed = new Set(["client:orbit", "client:orbit.fika", "client:tarkin-ladders", "client:swiftxp.showmethemoney.dll", "client:swiftxp.spt.showmethemoney.quicksell.dll"]);
  const isInstalled = (f) => installed.has(`${f.type}:${f.id.toLowerCase()}`);
  const ids = (folder) => A.addonLinkCandidates(ledger, folder, isInstalled).map((r) => r.forgeAddonId);

  check("Orbit.Fika is offered the ORBIT addon, and one already recorded there", json(ids(ORBIT_FIKA)), json([123, 60]));
  // ORBIT is the parent of both ORBIT records, merged and own-folder addons are excluded by their
  // evidence, and the last one's parent is not installed — so nothing at all is offered.
  check("the parent is never offered as an addon of itself", json(ids(ORBIT)), json([]));
}

/* --------------------------------------------------------- the repaired record */
console.log("\nthe ledger record after linking");
{
  const broken = { forgeAddonId: 123, name: "ORBIT - Fika Addon", version: "1.2.0", parentName: "ORBIT", parentType: "client", source: "forge", folders: [], mergedIntoParent: true, parentFiles: [] };
  const fixed = A.asOwnFolderRecord(broken, ORBIT_FIKA);
  check("it lists the folder", json(fixed.folders), json([ORBIT_FIKA]));
  check("it is no longer merged into the parent", fixed.mergedIntoParent, false);
  check("it keeps its catalogue id, version and source", json([fixed.forgeAddonId, fixed.version, fixed.source]), json([123, "1.2.0", "forge"]));
  check("linking twice does not list the folder twice", A.asOwnFolderRecord(fixed, { id: "orbit.fika", type: "client" }).folders.length, 1);
  check("the record it came from is not mutated", broken.folders.length, 0);
}

/* ----------------------------------------------- the version a linked row adopts */
console.log("\nadopting the ledger's version only while the files are unchanged");
{
  const install = path.join(root, "adopt");
  const folder = path.join(install, "BepInEx", "plugins", "Orbit.Fika");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "Orbit.Fika.dll"), "build 1.2.0");

  check("an untracked folder gets a row", M.trackFolderIfUntracked(install, "Orbit.Fika", "client", folder), true);
  check("a tracked one is left alone", M.trackFolderIfUntracked(install, "Orbit.Fika", "client", folder), false);
  const row = () => readJson(path.join(install, ".spt-mod-manager-registry.json")).find((e) => e.id === "Orbit.Fika");
  check("the new row claims no version", row().installedVersion, undefined);

  check(
    "files unchanged since the fingerprint: the ledger version is adopted",
    M.adoptLedgerVersionIfUnchanged(install, "Orbit.Fika", "client", folder, "1.2.0", "Addon ledger: ORBIT - Fika Addon 1.2.0", "forge"),
    true
  );
  check("the row now reads 1.2.0", row().installedVersion, "1.2.0");

  fs.writeFileSync(path.join(folder, "Orbit.Fika.dll"), "a different build dropped in by hand");
  check(
    "files changed since: nothing is claimed",
    M.adoptLedgerVersionIfUnchanged(install, "Orbit.Fika", "client", folder, "9.9.9", "x", "forge"),
    false
  );
  check("and the version is untouched", row().installedVersion, "1.2.0");
}

/* ------------------------------------------ a folder pulled from the server */
console.log("\na folder pulled from the server arrives as what it is THERE");
{
  const C = require(path.join(dist, "companion.js"));
  const S = require(path.join(dist, "sptServer.js"));

  // The shape of the real server's manifest (192.168.1.66, 2026-11-20), AFTER that machine's
  // records are repaired: the row carries addonOf and the ledger names the folder.
  const manifest = (registry, addons) => ({
    serverMods: [],
    clientMods: [
      { name: "ORBIT", kind: "folder", area: "plugins", enabled: true, guid: "com.chazut.orbit", declaredVersion: "3.1.1" },
      { name: "Orbit.Fika", kind: "folder", area: "plugins", enabled: true, guid: "com.chazut.orbit.fika", displayName: "ORBIT Fika Bridge", declaredVersion: "1.2.0" }
    ],
    registryJson: JSON.stringify(registry),
    addonsJson: JSON.stringify(addons),
    clientRootFound: true
  });
  const repairedRegistry = [
    { id: "ORBIT", type: "client", installedVersion: "3.1.1" },
    { id: "Orbit.Fika", type: "client", installedVersion: "1.2.0", addonOf: "ORBIT", addonOfType: "client", forgeAddonId: 123 }
  ];
  const repairedLedger = [
    { forgeAddonId: 123, name: "ORBIT - Fika Addon", version: "1.2.0", parentName: "ORBIT", parentType: "client", folders: [ORBIT_FIKA], mergedIntoParent: false, parentFiles: [] }
  ];
  // The snapshot as fetchServerSnapshot builds it. The ledger entries are the server's records
  // verbatim; the narrowing reader keeps the same field names, so they are used as they come.
  const snap = (m) => {
    const parsed = C.readManifest(m);
    return { clientMods: parsed.clientMods, remoteServerMods: parsed.serverMods, addons: parsed.addons };
  };

  const repaired = C.readManifest(manifest(repairedRegistry, repairedLedger));
  const row = repaired.clientMods.find((m) => m.id === "Orbit.Fika");
  check("the server's addon mark reaches the client's view of the row", row.addonOf, "ORBIT");
  check("with its catalogue addon id", row.forgeAddonId, 123);
  check("a plain mod carries no mark", repaired.clientMods.find((m) => m.id === "ORBIT").addonOf, undefined);

  const owner = S.remoteAddonForFolder(snap(manifest(repairedRegistry, repairedLedger)), ORBIT_FIKA);
  check("a repaired server says Orbit.Fika is the ORBIT Fika addon", owner && owner.name, "ORBIT - Fika Addon");
  check("as an own-folder addon", owner && owner.mergedIntoParent, false);
  check("of ORBIT", owner && owner.parentName, "ORBIT");

  // Only the registry mark, no ledger record naming the folder: still an addon, identified by id.
  const markOnly = S.remoteAddonForFolder(
    snap(manifest(repairedRegistry, [{ ...repairedLedger[0], folders: [], mergedIntoParent: true }])),
    ORBIT_FIKA
  );
  check("the registry mark alone is enough, matched by addon id", markOnly && markOnly.forgeAddonId, 123);
  check("and the record is rewritten to own the folder", markOnly && json(markOnly.folders), json([ORBIT_FIKA]));

  // The server AS IT IS TODAY: no mark, ledger "merged, no files". Its records say nothing, so
  // nothing is inferred — the name matching the ledger is deliberately not evidence.
  const today = S.remoteAddonForFolder(
    snap(
      manifest(
        [{ id: "Orbit.Fika", type: "client", installedVersion: "1.0.0", forgeName: "ORBIT - Fika Addon" }],
        [{ ...repairedLedger[0], folders: [], mergedIntoParent: true }]
      )
    ),
    ORBIT_FIKA
  );
  check("an unrepaired server's folder is NOT guessed to be an addon", today, undefined);
  check("a plain mod folder is not an addon", S.remoteAddonForFolder(snap(manifest(repairedRegistry, repairedLedger)), ORBIT), undefined);
  check(
    "the other half of the same folder name is not claimed",
    S.remoteAddonForFolder(snap(manifest(repairedRegistry, repairedLedger)), { id: "Orbit.Fika", type: "server" }),
    undefined
  );
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
