/**
 * Prepatcher parity and prepatcher dependencies, between a main install and a headless client.
 *
 * The incident this guards: MoreBotsPlugin was on both sides, so the plugin rows reported the two
 * installs as aligned — while MoreBotsPrepatch, its prepatcher, was missing from the headless
 * client. BlackDiv's prepatcher references MoreBotsPrepatch, so BepInEx refused to run it there,
 * and a raid crashed at init on a bot type BlackDiv should have added.
 *
 * Three layers, each tested on its own terms:
 *   1. reading assembly references out of real CLI metadata (assemblies built in memory — no
 *      third-party DLLs in the repo);
 *   2. the pure decision logic, with synthetic inputs;
 *   3. the whole thing on disk, in a temp folder, including the sync that repairs it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const { readAssemblyReferences } = require(path.join(dist, "peMetadata.js"));
const { buildPatcherParity, buildParityReport, scanPatcherParity } = require(path.join(dist, "headless.js"));
const {
  checkPatcherReferences,
  attributePatchers,
  findRelatedPatcherFiles,
  copyClientModToHeadless,
  copyReferencedPatchersToHeadless
} = require(path.join(dist, "modManager.js"));
const { buildAssembly } = require("./fake-assembly");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

/* ------------------------------------------------------------------------- */
console.log("\nreading assembly references");
{
  const r = readAssemblyReferences(buildAssembly({ name: "BlackDiv", refs: ["netstandard", "BepInEx", "MoreBotsPrepatch"] }));
  check("it is managed", r.managed, true);
  check("its own name comes from the Assembly table", r.name, "BlackDiv");
  check("its version too", r.version, "1.2.3.4");
  check("every reference, in order", r.references.map((x) => x.name), ["netstandard", "BepInEx", "MoreBotsPrepatch"]);

  // The schema bug this reader exposed: ClassLayout's ClassSize is 4 bytes, and declaring it as 2
  // shifted every table above 0x0F — Assembly and AssemblyRef included.
  const withLayout = readAssemblyReferences(buildAssembly({ name: "Shaped", refs: ["Dep"], classLayoutRows: 3 }));
  check("a ClassLayout table does not misalign the name", withLayout.name, "Shaped");
  check("or the references", withLayout.references.map((x) => x.name), ["Dep"]);

  const embedded = readAssemblyReferences(buildAssembly({ name: "Packer", refs: ["Inner"], resources: ["costura.inner.dll.compressed"] }));
  check("embedded resources are listed", embedded.embeddedResources, ["costura.inner.dll.compressed"]);

  check("a native DLL is not managed", readAssemblyReferences(buildAssembly({ name: "Native", native: true })).managed, false);
  check("nor is something that is not a PE at all", readAssemblyReferences(Buffer.from("not a dll")).managed, false);

  // The distinction that matters most: failing to read must never look like "depends on nothing".
  const torn = readAssemblyReferences(buildAssembly({ name: "Torn", refs: ["X"], corruptTables: true }));
  check("unreadable tables: still managed", torn.managed, true);
  check("unreadable tables: references UNDEFINED, not empty", torn.references, undefined);
}

/* ------------------------------------------------------------------------- */
console.log("\nparity: a plugin on both sides, its prepatcher missing on one");
{
  const plugin = (id) => ({ id, name: id, originalName: id, type: "client", enabled: true, version: "2.1.2" });
  // The plugin rows on their own: aligned, which is exactly what hid the problem.
  const plugins = buildParityReport([plugin("MoreBotsPlugin")], [plugin("MoreBotsPlugin")]);
  check("the plugin row reports no issue", plugins.rows[0].issue, undefined);

  const file = (entry, relPath, bytes = 100) => ({ entry, relPath, bytes });
  const report = buildPatcherParity({
    mainFiles: [file("MoreBotsPrepatch", "MoreBotsPrepatch/MoreBotsPrepatch.dll"), file("BlackDiv", "BlackDiv/BlackDiv.dll")],
    headlessFiles: [file("BlackDiv", "BlackDiv/BlackDiv.dll")],
    attribution: {
      byEntry: {
        morebotsprepatch: { kind: "mod", via: "ledger", mods: ["MoreBotsPlugin"] },
        blackdiv: { kind: "mod", via: "ledger", mods: ["BlackDiv"] }
      },
      byAssembly: { morebotsprepatch: ["MoreBotsPlugin"] }
    },
    headlessClientModIds: ["MoreBotsPlugin", "BlackDiv"]
  });
  const row = report.rows.find((r) => r.entry === "MoreBotsPrepatch");
  check("the prepatcher is reported missing anyway", row.issue, "missing-on-headless");
  check("attributed to its owner, from the install record", [row.owner.kind, row.owner.via, row.owner.mods], ["mod", "ledger", ["MoreBotsPlugin"]]);
  check("whose plugin is on the headless client", row.ownerOnHeadless, true);
  check("so Sync copies it", row.action, "copy");
  check("the detail names the owner", /installed with MoreBotsPlugin/.test(row.detail), true);
  check("it counts as missing", report.counts.missingOnHeadless, 1);
  check("and as one thing to sync", report.counts.toSync, 1);
  check("the matching prepatcher has no issue", report.rows.find((r) => r.entry === "BlackDiv").issue, undefined);
}

console.log("\nparity: the rest of what Sync may and may not copy");
{
  const file = (entry, relPath, bytes = 100) => ({ entry, relPath, bytes });
  const report = buildPatcherParity({
    mainFiles: [
      file("Folder", "Folder/Folder.dll"),
      file("Folder", "Folder/Helper.dll"),
      file("Rebuilt.dll", "Rebuilt.dll", 200),
      // Same size, different bytes: assemblies pad to 512-byte alignment, so this is the NORMAL
      // shape of a rebuild. A size-only comparison called it a match.
      { entry: "SameSize.dll", relPath: "SameSize.dll", bytes: 7680, hash: "aaaa" },
      { entry: "Identical.dll", relPath: "Identical.dll", bytes: 7680, hash: "cccc" },
      file("LeftOff", "LeftOff/LeftOff.dll"),
      file("Mystery.dll", "Mystery.dll"),
      file("spt-prepatch.dll", "spt-prepatch.dll", 300)
    ],
    headlessFiles: [
      file("Folder", "Folder/Folder.dll"),
      file("Rebuilt.dll", "Rebuilt.dll", 150),
      { entry: "SameSize.dll", relPath: "SameSize.dll", bytes: 7680, hash: "bbbb" },
      { entry: "Identical.dll", relPath: "Identical.dll", bytes: 7680, hash: "cccc" },
      file("Stale.dll", "Stale.dll")
    ],
    headlessDisabledFiles: [file("LeftOff", "LeftOff/LeftOff.dll")],
    attribution: {
      byEntry: {
        folder: { kind: "mod", via: "name", mods: ["Folder"] },
        "rebuilt.dll": { kind: "mod", via: "ledger", mods: ["Rebuilt"] },
        leftoff: { kind: "mod", via: "ledger", mods: ["LeftOffPlugin"] },
        "spt-prepatch.dll": { kind: "spt" }
      },
      byAssembly: {}
    },
    headlessClientModIds: ["Folder", "Rebuilt"]
  });
  const by = Object.fromEntries(report.rows.map((r) => [r.entry, r]));
  // The reproduction's exact shape: the folder stays, the DLL inside it goes.
  check("a folder missing one of its DLLs is incomplete, not present", by.Folder.issue, "incomplete-on-headless");
  check("and names the file", by.Folder.missingFiles, ["Folder/Helper.dll"]);
  check("a name-rule owner is said to be one", /going by its name/.test(by.Folder.detail), true);
  check("a different size is a different build", by["Rebuilt.dll"].issue, "different-build");
  check("which Sync replaces", by["Rebuilt.dll"].action, "copy");
  check("the SAME size with different contents is a different build too", by["SameSize.dll"].issue, "different-build");
  check("identical contents are a match", by["Identical.dll"].issue, undefined);
  check("a prepatcher whose known owner is left off the headless is NOT copied", by.LeftOff.action, "report");
  check("and says whose it is", /LeftOffPlugin/.test(by.LeftOff.detail), true);
  check("and that it is switched off there", /patchers\.disabled/.test(by.LeftOff.detail), true);
  check("an unattributed one is copied — main is the source of truth", by["Mystery.dll"].action, "copy");
  check("and is SAID to be unattributed, not given a guessed owner", /No install record or matching plugin/.test(by["Mystery.dll"].detail), true);
  check("SPT's own prepatcher is never copied", by["spt-prepatch.dll"].action, "report");
  check("a headless-only one is reported", by["Stale.dll"].issue, "headless-only");
  check("but not acted on", by["Stale.dll"].action, undefined);
  check("toSync counts the copies only", report.counts.toSync, 4);
}

console.log("\nparity: a prepatcher whose referenced assembly is missing");
{
  const file = (entry, relPath) => ({ entry, relPath, bytes: 100 });
  const mainRefs = {
    files: [
      { entry: "BlackDiv", relPath: "BlackDiv/BlackDiv.dll", assemblyName: "BlackDiv", managed: true, unresolved: [] },
      { entry: "MoreBotsPrepatch", relPath: "MoreBotsPrepatch/MoreBotsPrepatch.dll", assemblyName: "MoreBotsPrepatch", managed: true, unresolved: [] }
    ],
    providers: {
      blackdiv: { entry: "BlackDiv", relPath: "BlackDiv/BlackDiv.dll" },
      morebotsprepatch: { entry: "MoreBotsPrepatch", relPath: "MoreBotsPrepatch/MoreBotsPrepatch.dll" }
    },
    available: ["blackdiv", "morebotsprepatch", "bepinex"]
  };
  const headlessRefs = {
    files: [{ entry: "BlackDiv", relPath: "BlackDiv/BlackDiv.dll", assemblyName: "BlackDiv", managed: true, unresolved: ["MoreBotsPrepatch"] }],
    providers: { blackdiv: { entry: "BlackDiv", relPath: "BlackDiv/BlackDiv.dll" } },
    available: ["blackdiv", "bepinex"]
  };
  const report = buildPatcherParity({
    mainFiles: [file("BlackDiv", "BlackDiv/BlackDiv.dll"), file("MoreBotsPrepatch", "MoreBotsPrepatch/MoreBotsPrepatch.dll")],
    headlessFiles: [file("BlackDiv", "BlackDiv/BlackDiv.dll")],
    attribution: {
      byEntry: {
        blackdiv: { kind: "mod", via: "ledger", mods: ["BlackDiv"] },
        morebotsprepatch: { kind: "mod", via: "ledger", mods: ["MoreBotsPlugin"] }
      },
      byAssembly: { morebotsprepatch: ["MoreBotsPlugin"] }
    },
    // MoreBotsPlugin deliberately NOT on the headless: the dependency alone must still pull it.
    headlessClientModIds: ["BlackDiv"],
    mainRefs,
    headlessRefs
  });
  const ref = report.references[0];
  check("one broken reference, on the headless side", [report.references.length, ref.side], [1, "headless"]);
  check("naming who references what", [ref.assemblyName, ref.reference], ["BlackDiv", "MoreBotsPrepatch"]);
  check(
    "in the words the report uses",
    /BlackDiv \(patchers\/BlackDiv\/BlackDiv\.dll\) references MoreBotsPrepatch — not found on the headless client/.test(ref.detail),
    true
  );
  check("the main install's copy is identified", ref.providedOnMainBy, "MoreBotsPrepatch");
  check("so Sync copies it", ref.action, "copy");
  const row = report.rows.find((r) => r.entry === "MoreBotsPrepatch");
  check("copied even though its owner is not on the headless — another prepatcher needs it", row.action, "copy");
  check("the repair is counted once, not twice", report.counts.toSync, 1);

  // Missing on BOTH sides: copying cannot help, and the ledger names the parent to reinstall.
  const both = buildPatcherParity({
    mainFiles: [file("BlackDiv", "BlackDiv/BlackDiv.dll")],
    headlessFiles: [file("BlackDiv", "BlackDiv/BlackDiv.dll")],
    attribution: { byEntry: { blackdiv: { kind: "mod", via: "ledger", mods: ["BlackDiv"] } }, byAssembly: { morebotsprepatch: ["MoreBotsPlugin"] } },
    headlessClientModIds: ["BlackDiv"],
    mainRefs: { ...headlessRefs },
    headlessRefs
  });
  const mainSide = both.references.find((r) => r.side === "main");
  const hlSide = both.references.find((r) => r.side === "headless");
  check("missing on main is reported on main", !!mainSide, true);
  check("as a reinstall, not a copy", mainSide.action, "reinstall");
  check("naming the parent the ledger recorded", /arriving with MoreBotsPlugin/.test(mainSide.detail), true);
  check("the headless side says copying cannot fix it", hlSide.action, "reinstall");

  // And with no record at all, it says it cannot name one rather than guessing.
  const unknown = buildPatcherParity({
    mainFiles: [],
    headlessFiles: [],
    attribution: { byEntry: {}, byAssembly: {} },
    headlessClientModIds: [],
    mainRefs: { files: [{ entry: "X", relPath: "X.dll", assemblyName: "X", managed: true, unresolved: ["Nowhere"] }], providers: {}, available: [] }
  });
  check("an unrecorded dependency is not attributed by guesswork", /cannot name one to reinstall/.test(unknown.references[0].detail), true);

  const unreadable = buildPatcherParity({
    mainFiles: [],
    headlessFiles: [],
    attribution: { byEntry: {}, byAssembly: {} },
    headlessClientModIds: [],
    headlessRefs: { files: [{ entry: "Odd", relPath: "Odd.dll", managed: true }], providers: {}, available: [] }
  });
  check("an assembly that could not be read is listed as not checked", unreadable.unreadable, [{ side: "headless", patcher: "Odd.dll" }]);
}

/* ------------------------------------------------------------------------- */
console.log("\non disk: the incident, reproduced and repaired");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-patchers-"));
  const MAIN = path.join(root, "main");
  const HEADLESS = path.join(root, "headless");
  const write = (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const asm = (o) => buildAssembly(o);

  for (const side of [MAIN, HEADLESS]) {
    // What a real install resolves from outside patchers/.
    write(path.join(side, "BepInEx", "core", "BepInEx.dll"), asm({ name: "BepInEx" }));
    write(path.join(side, "BepInEx", "core", "Mono.Cecil.dll"), asm({ name: "Mono.Cecil" }));
    write(path.join(side, "EscapeFromTarkov_Data", "Managed", "Assembly-CSharp.dll"), asm({ name: "Assembly-CSharp" }));
    write(path.join(side, "BepInEx", "plugins", "MoreBotsPlugin", "MoreBotsPlugin.dll"), "plugin");
    write(path.join(side, "BepInEx", "plugins", "BlackDiv", "BlackDiv.dll"), "plugin");
    write(
      path.join(side, "BepInEx", "patchers", "BlackDiv", "BlackDiv.dll"),
      // netstandard: framework, skipped. Assembly-CSharp: Managed. BepInEx/Mono.Cecil: core.
      asm({ name: "BlackDiv", refs: ["netstandard", "BepInEx", "Mono.Cecil", "Assembly-CSharp", "MoreBotsPrepatch"] })
    );
  }
  write(path.join(HEADLESS, "FikaHeadlessManager.exe"), "stub");
  write(path.join(MAIN, "BepInEx", "patchers", "MoreBotsPrepatch", "MoreBotsPrepatch.dll"), asm({ name: "MoreBotsPrepatch", refs: ["BepInEx"] }));
  // The headless client as the user's reproduction leaves it: the folder, without its DLL.
  fs.mkdirSync(path.join(HEADLESS, "BepInEx", "patchers", "MoreBotsPrepatch"), { recursive: true });
  // A dependency that is only switched off does not count as present.
  write(path.join(HEADLESS, "BepInEx", "patchers.disabled", "MoreBotsPrepatch.dll"), asm({ name: "MoreBotsPrepatch" }));

  // The main install's ledger, in the shape the app writes it: the plugin points at its
  // archive's manifest, and the manifest records the prepatcher in its own folder.
  write(
    path.join(MAIN, ".spt-mod-manager-registry.json"),
    JSON.stringify([
      { id: "MoreBotsPlugin", type: "client", linkedModId: "hybrid-manifest-1" },
      { id: "hybrid-manifest-1", type: "hybrid", linkedModIds: ["MoreBotsServer", "MoreBotsPlugin"] }
    ])
  );
  write(
    path.join(MAIN, ".spt-mod-manager-manifest.json"),
    JSON.stringify({ "hybrid-manifest-1": ["BepInEx/patchers/MoreBotsPrepatch/MoreBotsPrepatch.dll"] })
  );

  const ids = ["MoreBotsPlugin", "BlackDiv"];

  // The old matching compared the manifest file's basename to the folder in patchers/, so it
  // never matched a folder-shaped prepatcher.
  const related = findRelatedPatcherFiles(path.join(MAIN, "BepInEx", "patchers"), "MoreBotsPlugin", [
    "BepInEx/patchers/MoreBotsPrepatch/MoreBotsPrepatch.dll"
  ]).map((f) => path.basename(f));
  check("the ledger attributes a FOLDER prepatcher to its plugin", related, ["MoreBotsPrepatch"]);
  check(
    "the name rule alone still does not (it cannot know)",
    findRelatedPatcherFiles(path.join(MAIN, "BepInEx", "patchers"), "MoreBotsPlugin").length,
    0
  );

  const attribution = attributePatchers(MAIN, ids, ["MoreBotsPrepatch", "BlackDiv"]);
  check("attributed from the install record", attribution.byEntry.morebotsprepatch, { kind: "mod", via: "ledger", mods: ["MoreBotsPlugin"] });
  check("BlackDiv falls back to the name rule, and says so", attribution.byEntry.blackdiv, { kind: "mod", via: "name", mods: ["BlackDiv"] });

  const mainRefs = checkPatcherReferences(MAIN);
  check(
    "the main install resolves everything (core, Managed, patchers; framework skipped)",
    mainRefs.files.map((f) => f.unresolved),
    [[], []]
  );
  const hlRefs = checkPatcherReferences(HEADLESS);
  check(
    "the headless client does not resolve MoreBotsPrepatch — patchers.disabled does not count",
    hlRefs.files.find((f) => f.entry === "BlackDiv").unresolved,
    ["MoreBotsPrepatch"]
  );

  const before = scanPatcherParity(MAIN, HEADLESS, ids, ids);
  // The folder is there, but with no DLL in it BepInEx has nothing to load — so it is missing,
  // and above all it is NOT counted as present, which comparing top-level entries would do.
  check("an emptied prepatcher folder is reported missing, not present", before.rows.find((r) => r.entry === "MoreBotsPrepatch").issue, "missing-on-headless");
  check("and Sync would copy it", before.rows.find((r) => r.entry === "MoreBotsPrepatch").action, "copy");
  check("the broken BlackDiv reference is reported", before.references.map((r) => `${r.side}:${r.assemblyName}->${r.reference}`), [
    "headless:BlackDiv->MoreBotsPrepatch"
  ]);

  // The repair, two ways. First: syncing the plugin brings its ledger-attributed prepatcher.
  let r = copyClientModToHeadless(MAIN, HEADLESS, { id: "MoreBotsPlugin", name: "MoreBotsPlugin", type: "client", enabled: true });
  check("syncing MoreBotsPlugin succeeds", r.success, true);
  check(
    "and brings MoreBotsPrepatch with it",
    fs.existsSync(path.join(HEADLESS, "BepInEx", "patchers", "MoreBotsPrepatch", "MoreBotsPrepatch.dll")),
    true
  );
  const after = scanPatcherParity(MAIN, HEADLESS, ids, ids);
  check("after which the prepatchers match", after.counts, {
    missingOnHeadless: 0,
    differentBuild: 0,
    headlessOnly: 0,
    brokenOnHeadless: 0,
    brokenOnMain: 0,
    unreadable: 0,
    toSync: 0
  });

  // Second: syncing BlackDiv alone follows its reference across to another mod's prepatcher.
  fs.rmSync(path.join(HEADLESS, "BepInEx", "patchers", "MoreBotsPrepatch"), { recursive: true, force: true });
  r = copyClientModToHeadless(MAIN, HEADLESS, { id: "BlackDiv", name: "BlackDiv", type: "client", enabled: true });
  check("syncing BlackDiv pulls in the prepatcher it references", r.copiedReferencedPatchers, ["MoreBotsPrepatch"]);
  check("and says so", /MoreBotsPrepatch, which its prepatcher depends on/.test(r.message), true);

  // And the standalone repair Sync-all uses, from a state where no plugin needs copying at all.
  fs.rmSync(path.join(HEADLESS, "BepInEx", "patchers", "MoreBotsPrepatch"), { recursive: true, force: true });
  const deps = copyReferencedPatchersToHeadless(MAIN, HEADLESS);
  check("dependency repair works with every plugin already in place", deps.copied.map((c) => [c.entry, c.reference, c.neededBy]), [
    ["MoreBotsPrepatch", "MoreBotsPrepatch", ["BlackDiv"]]
  ]);

  fs.rmSync(root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------------- */
console.log("\nSync-all's prepatcher pass, on disk");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-patcher-sync-"));
  const MAIN = path.join(root, "main");
  const HEADLESS = path.join(root, "headless");
  const write = (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const has = (...parts) => fs.existsSync(path.join(HEADLESS, "BepInEx", "patchers", ...parts));
  for (const side of [MAIN, HEADLESS]) {
    write(path.join(side, "BepInEx", "core", "BepInEx.dll"), buildAssembly({ name: "BepInEx" }));
    write(path.join(side, "BepInEx", "patchers", "BlackDiv", "BlackDiv.dll"), buildAssembly({ name: "BlackDiv", refs: ["BepInEx", "MoreBotsPrepatch"] }));
  }
  write(path.join(HEADLESS, "FikaHeadlessManager.exe"), "stub");
  // Main-only prepatchers, one per case.
  write(path.join(MAIN, "BepInEx", "patchers", "MoreBotsPrepatch", "MoreBotsPrepatch.dll"), buildAssembly({ name: "MoreBotsPrepatch", refs: ["BepInEx"] }));
  write(path.join(MAIN, "BepInEx", "patchers", "LeftOffPatch.dll"), buildAssembly({ name: "LeftOffPatch" }));
  write(path.join(MAIN, "BepInEx", "patchers", "spt-prepatch.dll"), buildAssembly({ name: "spt-prepatch" }));
  write(path.join(MAIN, "BepInEx", "patchers", "NeedsGhost.dll"), buildAssembly({ name: "NeedsGhost", refs: ["GhostLib"] }));
  write(
    path.join(MAIN, ".spt-mod-manager-registry.json"),
    JSON.stringify([
      { id: "MoreBotsPlugin", type: "client", linkedModId: "m1" },
      { id: "LeftOffPlugin", type: "client", linkedModId: "m2" },
      { id: "GhostMod", type: "client", linkedModId: "m3" }
    ])
  );
  write(
    path.join(MAIN, ".spt-mod-manager-manifest.json"),
    JSON.stringify({
      m1: ["BepInEx/patchers/MoreBotsPrepatch/MoreBotsPrepatch.dll"],
      m2: ["BepInEx/patchers/LeftOffPatch.dll"],
      // The ledger remembers GhostLib arriving with GhostMod, though it is on disk nowhere now.
      m3: ["BepInEx/patchers/NeedsGhost.dll", "BepInEx/patchers/GhostLib.dll"]
    })
  );
  const mainIds = ["MoreBotsPlugin", "BlackDiv", "LeftOffPlugin", "GhostMod"];
  // Every plugin that belongs on the headless client is already there — the incident's state.
  const headlessIds = ["MoreBotsPlugin", "BlackDiv", "GhostMod"];

  const { syncPatchersToHeadless } = require(path.join(dist, "headless.js"));
  const result = syncPatchersToHeadless(MAIN, HEADLESS, mainIds, headlessIds);

  check("with every plugin matched, the missing prepatcher is still copied", has("MoreBotsPrepatch", "MoreBotsPrepatch.dll"), true);
  check("a prepatcher whose owner was left off the headless is not", has("LeftOffPatch.dll"), false);
  check("SPT's own prepatcher is never copied", has("spt-prepatch.dll"), false);
  check("an unattributable-by-name but ledgered one goes when its plugin is there", has("NeedsGhost.dll"), true);
  check("what was copied is listed", result.copied.sort(), ["MoreBotsPrepatch", "NeedsGhost.dll"]);
  check("nothing failed", result.failed, []);
  // GhostLib is missing on BOTH sides: no copy can fix it, so it is reported, with the parent.
  check(
    "a dependency missing on main is reported as unfixable, on both sides",
    result.cannotFix.map((r) => `${r.side}:${r.assemblyName}->${r.reference}:${r.action}`).sort(),
    ["headless:NeedsGhost->GhostLib:reinstall", "main:NeedsGhost->GhostLib:reinstall"]
  );
  check("naming the mod to reinstall from the ledger", /arriving with GhostMod/.test(result.cannotFix[0].detail), true);

  const again = syncPatchersToHeadless(MAIN, HEADLESS, mainIds, headlessIds);
  check("a second sync has nothing left to copy", again.copied, []);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
