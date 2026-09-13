/**
 * Do the headless client's compatibility patches actually match the main install?
 *
 * This is the one class of difference the plugin comparison structurally cannot see. Most
 * addons unpack INTO their parent's folder, so the parent's row is byte-identical whether the
 * patch is inside it or not — same folder name, same version, same everything. The comparison
 * looks clean and the pair the patch reconciles is broken on one side only, which surfaces in
 * a raid rather than in the app.
 *
 * Until now the verdict for a merged addon was an INFERENCE: "its parent is synced, therefore
 * the patch came along". That is true right up until the parent is synced again from a copy
 * that never had the patch — at which point the inference reports health while the file is
 * gone. Addons record which files they placed precisely so this can be looked at instead, and
 * these tests pin the difference between looking and assuming.
 *
 * The own-folder cases are synthetic on purpose. Every addon on the reference install (8 of 8)
 * is merged, so that path has NO live coverage on this machine and would otherwise ship
 * unexercised.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildAddonParity } = require(path.join(__dirname, "..", "dist-electron", "headless.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const mod = (id, type = "client", enabled = true) => ({
  id,
  type,
  enabled,
  loadOrder: 1,
  originalName: id,
  name: id
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hl-addons-"));
const PLUGINS = ["BepInEx", "plugins"];
const DISABLED = ["BepInEx", "plugins.disabled"];

/** Lays down a parent folder on the fake headless client, with whichever files are named. */
function place(parentId, files, { enabled = true } = {}) {
  const dir = path.join(root, ...(enabled ? PLUGINS : DISABLED), parentId);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of files) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
  return dir;
}

/** The resolver main.ts builds, reproduced so the test covers the real lookup rule. */
const dirFor = (headlessMods) => (name, type) => {
  if (type === "server") return undefined;
  const parent = headlessMods.find((m) => m.id.toLowerCase() === name.toLowerCase() && m.type === type);
  if (!parent) return undefined;
  return path.join(root, ...(parent.enabled ? PLUGINS : DISABLED), parent.id);
};

/*
 * A SEPARATE fake main install. Both sides have to be looked at, so both have to exist here —
 * a test that only builds a headless folder can only ever prove half the check.
 */
const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hl-addons-main-"));

function placeMain(parentId, files, { enabled = true } = {}) {
  const dir = path.join(mainRoot, ...(enabled ? PLUGINS : DISABLED), parentId);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of files) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
  return dir;
}

const mainDirFor = (mainMods) => (name, type) => {
  if (type === "server") return undefined;
  const parent = mainMods.find((m) => m.id.toLowerCase() === name.toLowerCase() && m.type === type);
  if (!parent) return undefined;
  return path.join(mainRoot, ...(parent.enabled ? PLUGINS : DISABLED), parent.id);
};

try {
  console.log("merged addons: looking, not assuming");
  {
    const mainMods = [mod("SAIN"), mod("Solo")];
    const headlessMods = [mod("SAIN"), mod("Solo")];

    // SAIN on the headless client HAS the patch's file; Solo does not. Both parents are
    // present and correct, so nothing outside this check can tell them apart.
    place("SAIN", ["SAIN.dll", "patches/sain-fika.dll"]);
    place("Solo", ["Solo.dll"]);

    const parity = buildAddonParity(
      [
        { name: "SAIN Fika Patch", parentName: "SAIN", parentType: "client", mergedIntoParent: true, parentFiles: ["patches/sain-fika.dll"] },
        { name: "Solo Fika Patch", parentName: "Solo", parentType: "client", mergedIntoParent: true, parentFiles: ["patches/solo-fika.dll"] }
      ],
      mainMods,
      headlessMods,
      dirFor(headlessMods)
    );
    const by = Object.fromEntries(parity.map((p) => [p.name, p]));

    check("a patch whose file is there is confirmed present", by["SAIN Fika Patch"].status, "carried-with-parent");
    // The wording matters as much as the status: it is the difference between a fact and a
    // guess, and the user has no other way to tell which they are being shown.
    check("and says it was checked", /checked, not assumed/.test(by["SAIN Fika Patch"].detail), true);
    check("and is flagged verified", by["SAIN Fika Patch"].verified, true);

    // THE case this whole change exists for. Before it, this returned "carried-with-parent".
    check("a patch whose file is absent is caught", by["Solo Fika Patch"].status, "missing-on-headless");
    check("and names the parent to re-sync", /Sync "Solo" again/.test(by["Solo Fika Patch"].detail), true);
    check("and is still needed there", by["Solo Fika Patch"].needsHeadless, true);
  }

  console.log("\nBOTH installs are checked, not just the headless");
  {
    /*
     * The ledger records what was INSTALLED. It is not evidence of what is on disk now — a
     * parent reinstall takes a merged patch with it and changes nothing about the parent's own
     * row. Checking only the headless against such a record compares a real folder against a
     * record of one, and then either invents a difference or calls two gaps a match.
     */
    const mainMods = [mod("Alpha"), mod("Beta"), mod("Gamma"), mod("Delta")];
    const headlessMods = [mod("Alpha"), mod("Beta"), mod("Gamma"), mod("Delta")];

    placeMain("Alpha", ["Alpha.dll", "compat/p.dll"]);   // patch intact on main
    place("Alpha", ["Alpha.dll", "compat/p.dll"]);       // and on the headless
    placeMain("Beta", ["Beta.dll"]);                     // patch GONE from main...
    place("Beta", ["Beta.dll", "compat/p.dll"]);         // ...but still on the headless
    placeMain("Gamma", ["Gamma.dll"]);                   // gone from both
    place("Gamma", ["Gamma.dll"]);
    placeMain("Delta", ["Delta.dll", "compat/p.dll"]);   // present on main, absent on headless
    place("Delta", ["Delta.dll"]);

    const rec = (parent) => ({
      name: parent + " Patch",
      parentName: parent,
      parentType: "client",
      mergedIntoParent: true,
      parentFiles: ["compat/p.dll"]
    });
    const parity = buildAddonParity(
      [rec("Alpha"), rec("Beta"), rec("Gamma"), rec("Delta")],
      mainMods,
      headlessMods,
      dirFor(headlessMods),
      mainDirFor(mainMods)
    );
    const by = Object.fromEntries(parity.map((p) => [p.name, p]));

    check("intact on both is confirmed", by["Alpha Patch"].status, "carried-with-parent");
    check("and says BOTH were looked at", /BOTH the main instance and the headless client/.test(by["Alpha Patch"].detail), true);
    check("and is verified", by["Alpha Patch"].verified, true);

    // THE case. Previously this reported a healthy row: the headless genuinely has the file, and
    // nothing ever looked at the main install to notice the patch had been clobbered there.
    check("gone from main is caught even though the headless has it", by["Beta Patch"].status, "missing-on-main");
    check("and points at the main instance", /MAIN instance/.test(by["Beta Patch"].detail), true);
    check("and warns that syncing would spread the gap", /copy the gap/.test(by["Beta Patch"].detail), true);

    // Main is reported FIRST when both are gone: syncing cannot fix it, so telling someone to
    // sync would send them to the wrong machine.
    check("gone from both is reported against main", by["Gamma Patch"].status, "missing-on-main");

    // And the original direction still works, unchanged.
    check("present on main but not the headless still reports the headless", by["Delta Patch"].status, "missing-on-headless");
  }

  console.log("\na patch the MAIN install has a different build of");
  {
    const mainMods = [mod("Epsilon")];
    const headlessMods = [mod("Epsilon")];
    placeMain("Epsilon", ["Epsilon.dll", "compat/p.dll"]); // written as 1 byte by the harness
    place("Epsilon", ["Epsilon.dll", "compat/p.dll"]);

    // Recorded as a much larger file, so what is on main now is a DIFFERENT build — exactly what
    // a parent reinstall leaves behind: the path still there, the patch inside it gone.
    const parity = buildAddonParity(
      [
        {
          name: "Eps Patch",
          parentName: "Epsilon",
          parentType: "client",
          mergedIntoParent: true,
          parentFiles: ["compat/p.dll"],
          parentFileMarks: [{ path: "compat/p.dll", bytes: 4096, mtime: 1 }]
        }
      ],
      mainMods,
      headlessMods,
      dirFor(headlessMods),
      mainDirFor(mainMods)
    );
    check("a replaced file on main is caught", parity[0].status, "missing-on-main");
    check("and is described as replaced", /replaced by a different build/.test(parity[0].detail), true);
  }

  console.log("\na patch the headless client has a DIFFERENT build of");
  {
    /*
     * Presence alone cannot see this one. Sync the parent from a copy that never had the patch
     * and the patched file is OVERWRITTEN rather than deleted — it is still sitting there, so
     * every existence check calls the addon healthy while the headless runs unpatched content.
     *
     * mtime is deliberately not compared: syncing copies files and stamps them fresh, so it
     * would report every synced file as replaced. Size is what distinguishes the builds.
     */
    const mainMods = [mod("BigBrain"), mod("SAIN")];
    const headlessMods = [mod("BigBrain"), mod("SAIN")];
    place("BigBrain", ["BigBrain.dll", "compat/patch.dll"]);
    place("SAIN", ["SAIN.dll", "compat/patch.dll"]);

    const headlessDirs = dirFor(headlessMods);
    // BigBrain's copy is the addon's build; SAIN's is a different size, as a reinstall would leave it.
    fs.writeFileSync(path.join(headlessDirs("BigBrain", "client"), "compat", "patch.dll"), "the addon build");
    fs.writeFileSync(path.join(headlessDirs("SAIN", "client"), "compat", "patch.dll"), "a completely different build, longer");

    const marks = [{ path: "compat/patch.dll", bytes: "the addon build".length, mtime: 1 }];
    const parity = buildAddonParity(
      [
        { name: "BB Patch", parentName: "BigBrain", parentType: "client", mergedIntoParent: true, parentFiles: ["compat/patch.dll"], parentFileMarks: marks },
        { name: "SAIN Patch", parentName: "SAIN", parentType: "client", mergedIntoParent: true, parentFiles: ["compat/patch.dll"], parentFileMarks: marks }
      ],
      mainMods,
      headlessMods,
      headlessDirs
    );
    const by = Object.fromEntries(parity.map((p) => [p.name, p]));

    // Same size as recorded, different mtime because it was copied: still healthy.
    check("a matching build is confirmed present", by["BB Patch"].status, "carried-with-parent");
    check("despite the copy having a fresh mtime", by["BB Patch"].verified, true);

    check("a different build is caught", by["SAIN Patch"].status, "missing-on-headless");
    // Called what it is. Reporting this as "missing" would be a lie about a file sitting there.
    check("and is described as replaced, not missing", /replaced by a different build/.test(by["SAIN Patch"].detail), true);
  }

  console.log("\na parent disabled on the headless side");
  {
    // Disabled means plugins.disabled/, not gone. Looking in plugins/ would report every patch
    // inside it as missing, which is a false alarm on a folder the user deliberately parked.
    const headlessMods = [mod("BigBrain", "client", false)];
    place("BigBrain", ["BigBrain.dll", "compat/bb-patch.dll"], { enabled: false });

    const parity = buildAddonParity(
      [{ name: "BB Patch", parentName: "BigBrain", parentType: "client", mergedIntoParent: true, parentFiles: ["compat/bb-patch.dll"] }],
      [mod("BigBrain", "client", false)],
      headlessMods,
      dirFor(headlessMods)
    );
    check("a disabled parent is still looked in", parity[0].status, "carried-with-parent");
  }

  console.log("\naddons with folders of their own");
  {
    // Synthetic: no addon on the reference install takes this path.
    const mainMods = [mod("SAIN"), mod("Patch-A"), mod("Patch-B")];
    const headlessMods = [mod("SAIN"), mod("Patch-A")];

    const parity = buildAddonParity(
      [
        { name: "Standalone Present", parentName: "SAIN", parentType: "client", mergedIntoParent: false, folders: [{ id: "Patch-A", type: "client" }] },
        { name: "Standalone Absent", parentName: "SAIN", parentType: "client", mergedIntoParent: false, folders: [{ id: "Patch-B", type: "client" }] },
        { name: "Standalone Unknown", parentName: "SAIN", parentType: "client", mergedIntoParent: false }
      ],
      mainMods,
      headlessMods,
      dirFor(headlessMods)
    );
    const by = Object.fromEntries(parity.map((p) => [p.name, p]));

    // Settled from the scan. The old code said "check it was synced" for every own-folder
    // addon regardless, which pushed the work onto the user AND meant the sync count could
    // never reach zero while one existed.
    check("an own folder that is there is reported present", by["Standalone Present"].status, "present-on-headless");
    check("an own folder that is missing is actionable", by["Standalone Absent"].status, "needs-attention");
    check("and names the folder to copy", /Patch-B/.test(by["Standalone Absent"].detail), true);

    // A record from before folders were tracked has nothing to look at. It says so rather
    // than claiming either answer.
    check("no record of the folder falls back to asking", by["Standalone Unknown"].status, "needs-attention");
    check("and admits why", /no record of which/.test(by["Standalone Unknown"].detail), true);
  }

  console.log("\nwhat stays structural");
  {
    const headlessMods = [mod("SAIN")];
    const parity = buildAddonParity(
      [
        // A headless client has no server and never reads user/mods. No file check can change
        // that, so it must not run one — and must not be counted as work to do.
        { name: "Server Patch", parentName: "WTT-CAG", parentType: "server", mergedIntoParent: true, parentFiles: ["a.dll"] },
        // Parent absent from the headless client: the fix is the parent, and it is already in
        // the plugin count. Counting the addon too would double it.
        { name: "Orphan Patch", parentName: "Solo", parentType: "client", mergedIntoParent: true, parentFiles: ["b.dll"] }
      ],
      [mod("SAIN"), mod("WTT-CAG", "server"), mod("Solo")],
      headlessMods,
      dirFor(headlessMods)
    );
    const by = Object.fromEntries(parity.map((p) => [p.name, p]));

    check("a server-side patch is not applicable", by["Server Patch"].status, "not-applicable");
    check("and is not needed there", by["Server Patch"].needsHeadless, false);
    check("an absent parent points at the parent", by["Orphan Patch"].status, "parent-missing");
  }

  console.log("\nolder records without file lists");
  {
    // These predate the file list. The old inference is all there is for them, so it still
    // runs — but it is worded as an inference ("should have it"), not as a finding.
    const headlessMods = [mod("SAIN")];
    place("SAIN", ["SAIN.dll"]);
    const parity = buildAddonParity(
      [{ name: "Legacy Patch", parentName: "SAIN", parentType: "client", mergedIntoParent: true }],
      [mod("SAIN")],
      headlessMods,
      dirFor(headlessMods)
    );
    check("no file list still resolves", parity[0].status, "carried-with-parent");
    check("but hedges the wording", /should have it/.test(parity[0].detail), true);
    // The flag, not the prose, is what the badge reads. Without it a guess renders in the same
    // green as a verified row — which is exactly how a missing patch would stay invisible.
    check("and is flagged as NOT verified", parity[0].verified, false);

    // Measured on the reference install: all 8 addon records carry no file list, so every one
    // of them lands here. The check is correct and currently has nothing to check.
  }

  console.log("\nown folders without a recorded folder list");
  {
    const headlessMods = [mod("SAIN")];
    const parity = buildAddonParity(
      [{ name: "Legacy Standalone", parentName: "SAIN", parentType: "client", mergedIntoParent: false }],
      [mod("SAIN")],
      headlessMods,
      dirFor(headlessMods)
    );
    check("it is not claimed present", parity[0].status, "needs-attention");
    check("and carries no verified flag", parity[0].verified, undefined);
  }

  console.log("\nthe count the sync button shows");
  {
    // Mirrors HeadlessView's filter. Pinned here because getting it wrong is invisible: the
    // button reads "Headless in sync" and the patch is simply absent.
    const rows = [
      { status: "carried-with-parent" },
      { status: "present-on-headless" },
      { status: "not-applicable" },
      { status: "parent-missing" },
      { status: "missing-on-headless" },
      { status: "needs-attention" }
    ];
    const toSync = rows.filter((a) => a.status === "missing-on-headless" || a.status === "needs-attention").length;
    check("only the two the sync can act on are counted", toSync, 2);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(mainRoot, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll headless addon checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
