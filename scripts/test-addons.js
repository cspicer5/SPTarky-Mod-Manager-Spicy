/**
 * Addons — compatibility and companion mods (v1.2.2).
 *
 * The failures worth testing are the quiet ones:
 *
 *  - an addon built for a different version of its parent installs fine and then misbehaves
 *  - the parent gets updated and the addon silently stops matching
 *  - a GUID scrape claims a relationship that isn't there
 *  - an addon that ships two halves gets only one of them marked as an addon
 *
 * Everything happens in a temp directory; no real install is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const A = require(path.join(dist, "addons.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-addons-"));
const CLIENT = path.join(root, "install");

const w = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const mod = (id, type, extra = {}) => ({
  id,
  originalName: id,
  name: id.replace(/\.dll$/i, ""),
  type,
  enabled: true,
  loadOrder: 1,
  ...extra
});

/** Modelled on the real Quick-Sell: newest build is NOT the one older parents want. */
const QUICK_SELL = {
  id: 55,
  name: "Quick-Sell",
  modId: 2299,
  downloads: 900,
  versions: [
    { version: "2.3.0", link: "https://forge/dl/2.3.0", modConstraint: "~2.7.0" },
    { version: "2.2.2", link: "https://forge/dl/2.2.2", modConstraint: "<2.7.0" },
    { version: "1.2.0", link: "https://forge/dl/1.2.0", modConstraint: "~1.9.0" }
  ]
};

const SILENT = {
  id: 56,
  name: "Declares Nothing",
  modId: 900,
  versions: [{ version: "1.0.0", link: "https://forge/dl/n" }]
};

const NO_LINK = { id: 57, name: "No Download", modId: 901, versions: [{ version: "1.0.0" }] };

function main() {
  console.log("picking the build that fits the PARENT, not the newest");
  {
    // The whole point: an addon is pinned to a range of parent versions, so "latest" is the
    // wrong default. Same lesson the SPT version picker learned, one level down.
    const at27 = A.pickAddonVersionForParent(QUICK_SELL, "2.7.1");
    check("a 2.7.x parent gets the ~2.7.0 build", at27?.version.version, "2.3.0");
    check("and is reported as a declared fit", at27?.fit, "declared");

    const at26 = A.pickAddonVersionForParent(QUICK_SELL, "2.6.0");
    check("a 2.6 parent gets the <2.7.0 build, not the newest", at26?.version.version, "2.2.2");

    const at19 = A.pickAddonVersionForParent(QUICK_SELL, "1.9.2");
    // "<2.7.0" is satisfied by 1.9.2 and appears first, which is correct: both fit, and the
    // newer build wins a tie.
    check("an old parent still gets something that fits", at19?.version.version, "2.2.2");

    // Returning "something" here would install a build guaranteed not to work.
    check("a parent no build supports gets nothing", A.pickAddonVersionForParent(QUICK_SELL, "9.9.9"), undefined);

    const unknown = A.pickAddonVersionForParent(QUICK_SELL, undefined);
    check("an unknown parent version falls back to newest", unknown?.version.version, "2.3.0");
    check("...but says the fit was never checked", unknown?.fit, "unconstrained");
  }
  {
    // Restoring a build and PICKING one are different questions, and conflating them has shipped
    // here twice: preset sync installed the newest build instead of the one the preset recorded,
    // and "Match server" fetched the newest instead of the server's  both because no target
    // version ever reached the resolver. A reinstall that silently upgrades you is that bug a
    // third time, so it gets its own checks.
    const exact = A.pickAddonVersionToRestore(QUICK_SELL, "2.7.1", "2.2.2");
    check("restores the build asked for, not the newest that fits", exact?.version.version, "2.2.2");
    check("and reports that it restored it", exact?.restored, true);

    // Numerically, never as text. "2.2.2" and "2.2.2.0" are one build written two ways, and a
    // string compare would decline to restore the very version it was handed.
    const padded = A.pickAddonVersionToRestore(QUICK_SELL, "2.7.1", "2.2.2.0");
    check("a version written with a trailing zero still matches", padded?.version.version, "2.2.2");
    check("and still counts as restored", padded?.restored, true);

    const gone = A.pickAddonVersionToRestore(QUICK_SELL, "2.7.1", "9.9.9");
    check("a build the catalogue no longer carries falls back to what fits", gone?.version.version, "2.3.0");
    // The caller needs this to TELL the user, rather than handing over a different build silently.
    check("and says plainly that it could not restore", gone?.restored, false);

    const fresh = A.pickAddonVersionToRestore(QUICK_SELL, "2.7.1", undefined);
    check("with nothing asked for it behaves like a fresh install", fresh?.version.version, "2.3.0");
    check("and does not claim to have restored anything", fresh?.restored, false);
  }
  {
    const r = A.pickAddonVersionForParent(SILENT, "5.0.0");
    check("an addon declaring no constraint is a maybe, not a no", r?.version.version, "1.0.0");
    check("and is marked unconstrained", r?.fit, "unconstrained");
    check("an addon with no download link is unusable", A.pickAddonVersionForParent(NO_LINK, "1.0.0"), undefined);
  }

  console.log("\nmatching addons to what is installed");
  {
    const mods = [
      mod("showmethemoney", "server", { version: "2.7.0" }),
      mod("SomethingElse", "client", { version: "1.0.0" })
    ];
    const forgeIds = { showmethemoney: "2299", SomethingElse: "1" };
    const suggestions = A.suggestAddons(mods, forgeIds, [QUICK_SELL, SILENT]);
    check("only addons whose parent is installed", suggestions.length, 1);
    check("matched to the right parent", suggestions[0].parentName, "showmethemoney");
    check("with the parent's version", suggestions[0].parentVersion, "2.7.0");
    check("and the build that fits it", suggestions[0].pick.version, "2.3.0");
    check("not already installed", suggestions[0].installed, false);

    const known = A.suggestAddons(mods, forgeIds, [QUICK_SELL], new Set([55]));
    check("an installed addon is flagged as such", known[0].installed, true);
  }
  {
    // A mod shipping a server and a client half shares ONE Forge id. The constraint has to be
    // checked against the half that actually has a version; a client DLL often declares none.
    const mods = [mod("smtm", "server", { version: "2.7.0" }), mod("smtm", "client", {})];
    const suggestions = A.suggestAddons(mods, { smtm: "2299" }, [QUICK_SELL]);
    check("one suggestion, not two", suggestions.length, 1);
    check("checked against the half that has a version", suggestions[0].parentVersion, "2.7.0");
  }
  {
    const suggestions = A.suggestAddons([mod("x", "client", { version: "9.9.9" })], { x: "2299" }, [QUICK_SELL]);
    check("a parent no build supports is still listed", suggestions.length, 1);
    // "Nothing here works with your version" is a different answer from "this does not
    // exist", and sends the user to update the parent rather than to go looking.
    check("...marked as having no compatible build", suggestions[0].fit, "none");
    check("with nothing picked", suggestions[0].pick, undefined);
    // "Install anyway": declared requirements go stale, and the person installing may know the
    // addon works. The row needs to name exactly which build that would be and what it asks for.
    check("but the newest build is offered for Install anyway", suggestions[0].unfitBuild?.version, "2.3.0");
    check("with the requirement it is overriding", suggestions[0].unfitBuild?.modConstraint, "~2.7.0");
  }
  {
    // Only when nothing fits: a row with a fitting build must never offer the override.
    const fitting = A.suggestAddons([mod("x", "client", { version: "2.7.1" })], { x: "2299" }, [QUICK_SELL]);
    check("no override is offered when a build fits", fitting[0].unfitBuild, undefined);
    check("the newest build is the first with a download link", A.newestAddonBuild(QUICK_SELL)?.version, "2.3.0");
    check("and an addon with none offers nothing to override with", A.newestAddonBuild(NO_LINK), undefined);
  }
  {
    // After "Install anyway", the update check must not read the deliberate mismatch as "this was
    // probably folded into the mod" — that points at removing something chosen on purpose.
    const record = { forgeAddonId: 55, name: "Quick-Sell", version: "2.3.0", parentName: "x", parentType: "client", parentConstraint: "~2.7.0", installedAt: "2026-11-23T00:00:00Z", source: "forge", folders: [], mergedIntoParent: true };
    const rowFor = (r) => A.checkAddonUpdates([r], [QUICK_SELL], () => "9.9.9", () => true)[0];
    const plain = rowFor(record);
    check("a plain mismatch still suggests the patch may be built in", /part of x itself/.test(plain.detail), true);
    const anyway = rowFor({ ...record, installedAnyway: true });
    check("one installed anyway is described as that", /You installed this anyway/.test(anyway.detail), true);
    check("naming what it declares and what is installed", /~2\.7\.0.*9\.9\.9/.test(anyway.detail), true);
    check("and not as folded into the mod", /part of x itself/.test(anyway.detail), false);
  }

  console.log("\nnoticing that a parent has outgrown its addon");
  {
    // The quiet failure: the parent gets updated, the addon does not, and nothing says so.
    check("still fits", A.checkAddonFit("<2.7.0", "2.6.9"), "fits");
    check("parent moved past it", A.checkAddonFit("<2.7.0", "2.7.0"), "outgrown");
    check("tilde range still fits", A.checkAddonFit("~2.7.0", "2.7.4"), "fits");
    check("tilde range outgrown", A.checkAddonFit("~2.7.0", "2.8.0"), "outgrown");
    check("no constraint recorded", A.checkAddonFit(undefined, "2.7.0"), "unknown");
    check("no parent version to compare", A.checkAddonFit("~2.7.0", undefined), "unknown");
  }

  console.log("\nreading dependencies out of the assemblies");
  {
    // BepInEx stores the attribute's string argument in the assembly heaps, so a scrape finds
    // it without a metadata parser. Being a scrape, hits are candidates until the GUID turns
    // out to belong to another INSTALLED mod.
    w(path.join(CLIENT, "BepInEx", "plugins", "ChildMod", "ChildMod.dll"), "  me.sol.sain BepInDependency xyz.drakia.bigbrain ");
    w(path.join(CLIENT, "BepInEx", "plugins", "Parent", "Parent.dll"), " me.sol.sain ");
    w(path.join(CLIENT, "BepInEx", "plugins", "BigBrain.dll"), " xyz.drakia.bigbrain ");
    w(path.join(CLIENT, "BepInEx", "plugins", "Loner", "Loner.dll"), " System.Collections.Generic Newtonsoft.Json.Linq something.txt ");

    const mods = [
      mod("ChildMod", "client"),
      mod("Parent", "client", { guid: "me.sol.sain" }),
      mod("BigBrain.dll", "client", { guid: "xyz.drakia.bigbrain" }),
      mod("Loner", "client")
    ];

    const links = A.detectAddonLinks(CLIENT, mods);
    const child = links.filter((l) => l.name === "ChildMod");
    check("found both declared dependencies", child.length, 2);
    check("resolved to installed mods", child.map((l) => l.parentName).sort().join(","), "BigBrain.dll,Parent");
    check("recorded how it was established", child[0].method, "declared-guid");

    // Framework namespaces and filenames dominate the raw hits and are never mod GUIDs.
    check("no relationship invented for a mod that references nothing", links.filter((l) => l.name === "Loner").length, 0);
    // A plugin's own GUID appears in its own assembly; that is a declaration, not a dependency.
    check("a mod is never its own addon", links.filter((l) => l.name === l.parentName).length, 0);
  }
  {
    // The user's judgement outranks anything derived, exactly as a manual Forge pin outranks
    // every matching strategy.
    const mods = [mod("ChildMod", "client"), mod("Parent", "client", { guid: "me.sol.sain" })];
    const links = A.detectAddonLinks(CLIENT, mods, { "client:childmod": "Parent" });
    const child = links.filter((l) => l.name === "ChildMod");
    check("a manual link wins", child.length, 1);
    check("and is recorded as manual", child[0].method, "manual");
    check("pointing where the user said", child[0].parentName, "Parent");
  }

  console.log("\nintegrations a mod knows about but does not have");
  {
    // NOT called "missing dependencies": BepInDependency carries a hard/soft flag that a
    // scrape cannot see. On the reference install all four hits are soft — that install runs,
    // and a missing HARD dependency stops BepInEx loading the plugin at all.
    const mods = [mod("ChildMod", "client"), mod("Parent", "client", { guid: "me.sol.sain" })];
    const catalogue = { "xyz.drakia.bigbrain": { id: 902, name: "BigBrain" } };
    const found = A.findKnownIntegrations(CLIENT, mods, (g) => catalogue[g.toLowerCase()]);
    check("finds the one it does not have", found.length, 1);
    check("named from the Forge catalogue", found[0].forgeName, "BigBrain");
    check("with its id, so it can be installed", found[0].forgeId, 902);

    // An unresolvable dotted string is far more likely to be a namespace the scrape picked up
    // than a real mod; guessing would bury the real answers in noise.
    const none = A.findKnownIntegrations(CLIENT, mods, () => undefined);
    check("unknown GUIDs are not reported as mods", none.length, 0);
  }

  console.log("\nmarking an installed folder as an addon");
  {
    const REG = path.join(root, "registry.json");
    fs.writeFileSync(
      REG,
      JSON.stringify([
        { id: "PatchClient", type: "client", installedVersion: "1.0.0" },
        { id: "PatchServer", type: "server", installedVersion: "1.0.0" },
        { id: "TheParent", type: "server", installedVersion: "2.7.0" }
      ])
    );

    // An addon archive can drop a server part AND a client part, exactly like a mod. Marking
    // only the one the caller named would leave the other looking like an unrelated mod.
    const marked = A.markInstalledAsAddon(
      REG,
      [
        { id: "PatchClient", type: "client" },
        { id: "PatchServer", type: "server" },
        { id: "TheParent", type: "server" }
      ],
      { parentName: "TheParent", parentType: "server", forgeAddonId: 55, parentConstraint: "~2.7.0" }
    );
    check("both halves marked", marked, 2);

    const reg = JSON.parse(fs.readFileSync(REG, "utf-8"));
    check("client half points at the parent", reg.find((e) => e.id === "PatchClient").addonOf, "TheParent");
    check("server half too", reg.find((e) => e.id === "PatchServer").addonOf, "TheParent");
    check("the constraint is kept for later", reg.find((e) => e.id === "PatchClient").addonParentConstraint, "~2.7.0");
    check("forge addon id kept", reg.find((e) => e.id === "PatchClient").forgeAddonId, 55);
    // A mod is never its own addon, even when the parent appears in the install result.
    check("the parent was not marked as its own addon", reg.find((e) => e.id === "TheParent").addonOf, undefined);

    check("clearing works", A.clearAddonMark(REG, "PatchClient", "client"), true);
    const after = JSON.parse(fs.readFileSync(REG, "utf-8"));
    check("the mark is gone", after.find((e) => e.id === "PatchClient").addonOf, undefined);
    check("clearing something that was never an addon is a no-op", A.clearAddonMark(REG, "TheParent", "server"), false);
  }

  console.log("\nan addon that unpacks INTO its parent's folder");
  {
    // Both bugs found by installing real addons. Manimal's Icebreaker Fika Sync unpacks into
    // the parent's ManimalIcebreaker folders; the CAG BRNVG patch unpacks into BorkelRNVG.
    // Neither creates a folder of its own, so "what appeared after the install" is EMPTY.
    const INST = path.join(root, "merged-install");
    fs.mkdirSync(INST, { recursive: true });
    const REG = path.join(INST, ".spt-mod-manager-registry.json");

    fs.writeFileSync(
      REG,
      JSON.stringify([
        {
          id: "BorkelRNVG",
          type: "client",
          installedVersion: "2.1.1",
          versionOrigin: "forge",
          versionEvidence: "Forge: Borkel's Realistic Night Vision Goggles 2.1.1"
        }
      ])
    );

    // BUG 1: the addon was installed and the panel kept offering it, because nothing was
    // recorded anywhere. The ledger records the install itself rather than inferring it.
    check("nothing recorded yet", A.loadAddonLedger(INST).length, 0);
    A.recordAddonInstall(INST, {
      forgeAddonId: 100,
      name: "CAG BRNVG patch",
      version: "1.0.0",
      parentName: "BorkelRNVG",
      parentType: "client",
      parentConstraint: "~2.1.1",
      installedAt: new Date().toISOString(),
      source: "forge",
      folders: [],
      mergedIntoParent: true
    });
    const ledger = A.loadAddonLedger(INST);
    check("the install is recorded", ledger.length, 1);
    check("even with no folder of its own", ledger[0].mergedIntoParent, true);
    check("so the panel can say it is installed", ledger[0].forgeAddonId, 100);

    // Re-installing must not produce a duplicate row.
    A.recordAddonInstall(INST, { ...ledger[0], version: "1.0.1" });
    check("reinstalling updates rather than duplicates", A.loadAddonLedger(INST).length, 1);
    check("with the new version", A.loadAddonLedger(INST)[0].version, "1.0.1");

    // BUG 2, the worse one: the addon's own version was written over the PARENT's record.
    // Borkel's RNVG 2.1.1 was relabelled 1.0.0 on the real install, and the app then trusted
    // the wrong number over what the files declared — the exact failure the version ledger
    // exists to prevent.
    const before = A.snapshotVersions(REG);
    const clobbered = JSON.parse(fs.readFileSync(REG, "utf-8"));
    clobbered[0].installedVersion = "1.0.0";
    clobbered[0].versionEvidence = "Forge: CAG BRNVG patch 1.0.0";
    // A folder the addon genuinely created for itself IS the addon, and keeps its version.
    clobbered.push({ id: "PatchOwnFolder", type: "client", installedVersion: "1.0.0", versionOrigin: "forge" });
    fs.writeFileSync(REG, JSON.stringify(clobbered));

    const restored = A.restoreClobberedVersions(REG, before);
    check("the parent's version was put back", restored.length, 1);
    check("naming what it repaired", restored[0], "BorkelRNVG [client]");

    const after = JSON.parse(fs.readFileSync(REG, "utf-8"));
    const borkel = after.find((e) => e.id === "BorkelRNVG");
    check("parent is 2.1.1 again", borkel.installedVersion, "2.1.1");
    check("with its own evidence", /Borkel/.test(borkel.versionEvidence), true);
    // Only pre-existing entries are protected: a new folder is the addon's, not the parent's.
    check("the addon's own folder keeps its version", after.find((e) => e.id === "PatchOwnFolder").installedVersion, "1.0.0");

    // Found on the live install: an addon whose version EQUALS its parent's slipped through a
    // version-only comparison while still rewriting the provenance. Manimal's Icebreaker Fika
    // Sync is 0.2.1 and so is the mod it patches, so the parent kept the right number
    // attributed to entirely the wrong thing.
    const REG2 = path.join(root, "same-version.json");
    fs.writeFileSync(
      REG2,
      JSON.stringify([
        {
          id: "ManimalIcebreaker",
          type: "client",
          installedVersion: "0.2.1",
          versionOrigin: "forge",
          versionEvidence: "Forge: Manimal's Icebreaker Backport 0.2.1"
        }
      ])
    );
    const snap2 = A.snapshotVersions(REG2);
    const rewritten = JSON.parse(fs.readFileSync(REG2, "utf-8"));
    rewritten[0].versionEvidence = "Forge: MANIMAL'S ICEBREAKER BACKPORT FIKA SYNC 0.2.1";
    fs.writeFileSync(REG2, JSON.stringify(rewritten));

    const restored2 = A.restoreClobberedVersions(REG2, snap2);
    check("a same-version addon is still caught", restored2.length, 1);
    check(
      "and the parent's own evidence is put back",
      JSON.parse(fs.readFileSync(REG2, "utf-8"))[0].versionEvidence,
      "Forge: Manimal's Icebreaker Backport 0.2.1"
    );
    // An install that changed nothing must not be rewritten for the sake of it.
    check("an untouched registry is left alone", A.restoreClobberedVersions(REG2, A.snapshotVersions(REG2)).length, 0);

    // Reinstalling the parent replaces its folder and takes the merged addon's files with
    // it — in silence, since nothing about the parent's own row changes. Exactly what
    // happened when the version above was repaired by reinstalling Borkel's RNVG.
    const rec = A.loadAddonLedger(INST)[0];
    const parentAt = (name) => (name === "BorkelRNVG" ? "2000-01-01T00:00:00.000Z" : undefined);
    check("a parent installed BEFORE the addon leaves it alone", A.addonsNeedingReinstall([rec], parentAt).length, 0);

    const laterParent = () => new Date(Date.parse(rec.installedAt) + 60_000).toISOString();
    check("a parent reinstalled AFTER wipes it", A.addonsNeedingReinstall([rec], laterParent).length, 1);

    // An addon with its own folder survives a parent reinstall, so it must not be flagged.
    const standalone = { ...rec, mergedIntoParent: false, folders: [{ id: "Own", type: "client" }] };
    check("an addon with its own folder survives", A.addonsNeedingReinstall([standalone], laterParent).length, 0);

    /*
     * The FILE check, which replaces all of the above reasoning wherever it can.
     *
     * Timestamps can only ever infer whether an addon survived. Its files answer the question.
     */
    const filesDir = path.join(root, "parentfolder");
    fs.mkdirSync(path.join(filesDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "patch.dll"), "x");
    fs.writeFileSync(path.join(filesDir, "sub", "data.json"), "{}");
    const withFiles = { ...rec, parentFiles: ["patch.dll", "sub/data.json"] };
    const dirFor = () => filesDir;

    check("files still on disk mean the addon survived", A.addonsNeedingReinstall([withFiles], laterParent, dirFor).length, 0);
    // ...even though the timestamp rule alone would have condemned it. That is the point: a look
    // at the disk outranks an inference about install order.
    check("and that outranks a parent stamped later", A.addonsNeedingReinstall([withFiles], laterParent).length, 1);

    fs.rmSync(path.join(filesDir, "sub", "data.json"));
    check("a missing file means it was wiped", A.addonsNeedingReinstall([withFiles], parentAt, dirFor).length, 1);
    // Joined, because this file's `check` compares with === and two arrays never are.
    check("and it names which file", A.missingAddonFiles(filesDir, withFiles).join(","), "sub/data.json");

    /*
     * The false positive this was really about, reproduced.
     *
     * A merged addon stamps its PARENT as it writes into that folder. With two addons on one
     * parent, installing the second stamps the parent after the first — and the first is then
     * reported as wiped forever, with nothing wiped and nothing to do. Measured on the reference
     * install: BorkelRNVG is stamped 255ms before the second of its two patches.
     */
    const first = { ...rec, name: "first patch", installedAt: "2026-08-09T18:24:48.164Z", parentFiles: undefined };
    const second = { ...rec, name: "second patch", installedAt: "2026-08-10T01:21:23.134Z", parentFiles: undefined };
    const stampedByAddon = () => "2026-08-10T01:21:22.879Z";
    check(
      "a parent stamp written by a SIBLING addon does not condemn the first",
      A.addonsNeedingReinstall([first, second], stampedByAddon).length,
      0
    );
    // A genuine reinstall, far from any addon's own time, is still caught.
    const genuineReinstall = () => "2026-08-11T09:00:00.000Z";
    check("a real parent reinstall is still caught", A.addonsNeedingReinstall([first, second], genuineReinstall).length, 2);

    check("forgetting works", A.forgetAddon(INST, { forgeAddonId: 100 }), true);
    check("and it is gone", A.loadAddonLedger(INST).length, 0);
    check("forgetting something absent is a no-op", A.forgetAddon(INST, { forgeAddonId: 999 }), false);
  }

  console.log("\naddons survive a preset round trip");
  {
    const P = require(path.join(dist, "presets.js"));
    const LOCAL = path.join(root, "presets");
    fs.mkdirSync(LOCAL, { recursive: true });

    const installed = [
      mod("TheParent", "server", { version: "2.7.0" }),
      mod("ThePatch", "client", {
        version: "1.0.0",
        addonOf: "TheParent",
        addonOfType: "server",
        forgeAddonId: 55,
        addonParentConstraint: "~2.7.0"
      }),
      mod("Unrelated", "client", { version: "3.0.0" })
    ];

    const preset = P.createPreset(LOCAL, installed, { name: "With Addons", sptVersion: "4.0.13" });
    const patch = preset.mods.find((m) => m.name === "ThePatch");
    check("the relationship is captured", patch.addonOf, "TheParent");
    check("with the parent's side", patch.addonOfType, "server");
    check("and the constraint, so a stranded addon can be spotted later", patch.addonParentConstraint, "~2.7.0");
    check("and the Forge addon id", patch.forgeAddonId, 55);
    check("an ordinary mod gains nothing", preset.mods.find((m) => m.name === "Unrelated").addonOf, undefined);

    const report = P.buildPresetReport(preset, installed, "4.0.13");
    check("a coherent preset has no orphans", report.counts.orphanedAddon, 0);
    check("addons are grouped by what they attach to", report.addonsByParent.TheParent.join(), "ThePatch");
    check("the addon row carries its parent", report.rows.find((r) => r.name === "ThePatch").addonOf, "TheParent");

    // The failure only the relationship reveals: the addon installs, every file is present,
    // and the setup is nonsense.
    const orphaned = P.createPreset(LOCAL, installed.filter((m) => m.id !== "TheParent"), { name: "Missing Parent" });
    const orphanReport = P.buildPresetReport(orphaned, installed, "4.0.13");
    check("an addon without its parent is flagged", orphanReport.counts.orphanedAddon, 1);
    const row = orphanReport.rows.find((r) => r.name === "ThePatch");
    check("named as such", row.issue, "orphaned-addon");
    check("saying which parent is missing", /TheParent/.test(row.detail), true);
    // It would otherwise pass every existing check, which is the whole point.
    check("...even though the addon itself is installed", installed.some((m) => m.id === "ThePatch"), true);
  }

  console.log("\na preset carries addons that have NO folder of their own");
  {
    // The gap this closes, measured on the live install: 3 addons installed, all merged into
    // their parent, and a preset captured from it described 0 of them. The mod-row fields
    // only work for an addon with its own folder, and most have none.
    const P = require(path.join(dist, "presets.js"));
    const LOCAL = path.join(root, "presets-addons");
    fs.mkdirSync(LOCAL, { recursive: true });

    const installed = [mod("WTT-CAG", "server", { version: "1.0.0+pre2" }), mod("BorkelRNVG", "client", { version: "2.1.1" })];
    const ledger = [
      {
        name: "CAG BRNVG patch",
        forgeAddonId: 100,
        version: "1.0.0",
        parentName: "WTT-CAG",
        parentType: "server",
        parentConstraint: "~1.0.0",
        source: "forge",
        mergedIntoParent: true
      }
    ];

    const preset = P.createPreset(LOCAL, installed, { name: "With Merged Addon", addons: ledger });
    check("the addon is carried", preset.addons.length, 1);
    check("even though no mod row mentions it", preset.mods.filter((m) => m.addonOf).length, 0);
    check("with its parent", preset.addons[0].parentName, "WTT-CAG");
    check("its constraint", preset.addons[0].parentConstraint, "~1.0.0");
    check("and the fact it has no folder", preset.addons[0].mergedIntoParent, true);

    // An install that has the parent but not the patch. Nothing in the mod list differs —
    // which is exactly why this needed its own comparison.
    const bare = P.buildPresetReport(preset, installed, undefined, []);
    check("the missing addon is spotted", bare.addonRows.length, 1);
    check("marked missing", bare.addonRows[0].status, "missing");
    // A compatibility patch exists to stop two mods breaking each other, and the pair it
    // patches IS installed, so this is not a cosmetic difference.
    check("and the preset is not satisfied", bare.satisfied, false);
    check("the mod rows themselves look perfect", bare.counts.missingRequired + bare.counts.versionMismatch, 0);

    const matched = P.buildPresetReport(preset, installed, undefined, ledger);
    check("an install that has it reports present", matched.addonRows[0].status, "present");
    check("and is satisfied", matched.satisfied, true);

    // Matching by Forge id, so a renamed addon still resolves.
    const renamed = P.buildPresetReport(preset, installed, undefined, [{ ...ledger[0], name: "totally different name" }]);
    check("matched by forge id, not name", renamed.addonRows[0].status, "present");

    const noParent = P.buildPresetReport(preset, [mod("BorkelRNVG", "client", { version: "2.1.1" })], undefined, []);
    // "The mod it patches is not here" sends you somewhere completely different from
    // "the patch is not here".
    check("a missing parent is its own answer", noParent.addonRows[0].status, "parent-missing");
    check("and says which mod", /WTT-CAG/.test(noParent.addonRows[0].detail), true);

    // An addon whose parent was filtered out of the preset would be unapplicable by
    // construction, so it is never recorded as a promise the preset cannot keep.
    const filtered = P.createPreset(LOCAL, installed, {
      name: "Only Borkel",
      include: ["BorkelRNVG"],
      addons: ledger
    });
    check("an addon for an excluded mod is dropped", filtered.addons.length, 0);

    // Re-capturing must not silently lose them.
    const rescanned = P.updatePreset(LOCAL, preset.id, installed, undefined, ledger);
    check("still carried after a re-capture", rescanned.addons.length, 1);
    const noArg = P.updatePreset(LOCAL, preset.id, installed, undefined);
    check("and kept when the caller passes none", noArg.addons.length, 1);
  }

  console.log("\nthe real harvested catalogue");
  {
    const catalogue = A.loadAddonCatalogue([path.join(__dirname, "..", "data", "forge-addons.json")]);
    check("loads", catalogue.length > 0, true);
    check("every addon names a parent", catalogue.filter((a) => !a.modId).length, 0);
    check("every addon has at least one version", catalogue.filter((a) => a.versions.length === 0).length, 0);
    // Without a link the app can only ever point at a web page, which after the shutdown is
    // a page that no longer exists.
    check("every addon has a download link", catalogue.filter((a) => !a.versions.some((v) => v.link)).length, 0);
  }

  console.log("\nwhat an addon actually contributed to its parent");
  {
    // The original rule recorded only files that were NEW, which is the wrong half of the
    // problem. Most real patches OVERWRITE something the parent already ships — on the live
    // server 7 of 8 addons had an empty list ("Quick-Sell", both Borkel NVG supports, the Fika
    // syncs), so the file check that exists to replace guesswork never ran for any of them.
    const parent = path.join(root, "ParentFolder");
    fs.mkdirSync(path.join(parent, "Assets"), { recursive: true });
    const shipped = path.join(parent, "Assets", "shipped.bundle");
    const untouched = path.join(parent, "readme.txt");
    fs.writeFileSync(shipped, "the parent's own copy");
    fs.writeFileSync(untouched, "nobody touches this");
    // Pinned so the comparison is about content changing, not about how fast the test runs.
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(shipped, old, old);
    fs.utimesSync(untouched, old, old);

    const before = A.snapshotFolderFiles(parent);

    // The addon lands: it REPLACES one file the parent shipped and adds one of its own.
    fs.writeFileSync(shipped, "the addon's patched copy, a different size");
    fs.writeFileSync(path.join(parent, "Assets", "patch.dll"), "new from the addon");

    const contribution = A.diffAddonContribution(before, A.snapshotFolderFiles(parent));
    const paths = contribution.map((m) => m.path);
    check("the OVERWRITTEN file is counted as contributed", paths.includes("Assets/shipped.bundle"), true);
    check("so is the added one", paths.includes("Assets/patch.dll"), true);
    check("and a file nobody touched is not", paths.includes("readme.txt"), false);
    check("each carries the signature it landed with", typeof contribution[0].bytes, "number");

    const record = { parentFiles: paths, parentFileMarks: contribution };
    const states = () => Object.fromEntries(A.checkAddonFiles(parent, record).map((r) => [r.path, r.state]));
    check("straight after installing, everything is present", JSON.stringify(states()), JSON.stringify({ "Assets/patch.dll": "present", "Assets/shipped.bundle": "present" }));

    // The case presence alone CANNOT see: the parent is reinstalled over the top and takes the
    // patch back. The path still exists, so a presence check would call the addon healthy.
    fs.writeFileSync(shipped, "the parent's own copy, restored by a reinstall");
    check("an overwritten file is reported replaced, not present", states()["Assets/shipped.bundle"], "replaced");
    check("and presence alone would have missed it", A.missingAddonFiles(parent, record).length, 0);

    fs.rmSync(path.join(parent, "Assets", "patch.dll"));
    check("a deleted file is still reported missing", states()["Assets/patch.dll"], "missing");

    // An older record carries no signatures. It can only be checked for presence, and must not
    // invent a "replaced" verdict it has no evidence for.
    const legacy = { parentFiles: ["Assets/shipped.bundle"] };
    check("a record without marks falls back to presence only", A.checkAddonFiles(parent, legacy)[0].state, "present");
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
