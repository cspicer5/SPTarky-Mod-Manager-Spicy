/**
 * Making an install match a preset.
 *
 * The downloading is the easy half. The half worth testing is deciding WHERE each mod comes
 * from, and refusing to guess when the answer is "nowhere" — installing something with a
 * similar name into a game install is not a small mistake.
 */
const path = require("path");
const dist = path.join(__dirname, "..", "dist-electron");
const { buildSyncPlan, describeSyncPlan } = require(path.join(dist, "presetSync.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const presetMod = (name, extra = {}) => ({
  name,
  type: "client",
  enabled: true,
  loadOrder: 1,
  required: true,
  version: "1.0.0",
  ...extra
});

const row = (name, issue, extra = {}) => ({
  key: `client:${name.toLowerCase()}`,
  name,
  type: "client",
  issue,
  required: true,
  presetVersion: "1.0.0",
  presetEnabled: true,
  ...extra
});

const makeReport = (rows, addonRows = []) => ({
  presetId: "p",
  presetName: "P",
  rows,
  addonRows,
  counts: {
    matching: 0,
    missing: rows.filter((r) => r.issue === "missing").length,
    missingRequired: 0,
    versionMismatch: 0,
    stateMismatch: 0,
    extra: 0,
    unknownVersion: 0,
    orphanedAddon: 0
  },
  satisfied: false
});

function main() {
  console.log("where each missing mod comes from");
  {
    const preset = {
      schema: 1,
      id: "p",
      name: "P",
      createdAt: "",
      updatedAt: "",
      hasPayloads: true,
      mods: [
        presetMod("Carried", { payload: "client_Carried@1.0.0", sizeBytes: 5000 }),
        presetMod("OnGithub", { sourceUrl: "https://github.com/someone/OnGithub" }),
        presetMod("OnlyForge", {}),
        presetMod("Nowhere", {})
      ]
    };
    const report = makeReport([
      row("Carried", "missing"),
      row("OnGithub", "missing"),
      row("OnlyForge", "missing"),
      row("Nowhere", "missing")
    ]);

    const withEverything = buildSyncPlan(preset, report, { storeConnected: true, forgeAvailable: true });
    const by = Object.fromEntries(withEverything.steps.map((s) => [s.name, s.source]));
    // Exact bytes, no network, unaffected by the shutdown — always preferred.
    check("a carried mod comes from the payload", by.Carried, "payload");
    // Survives the shutdown, so it beats the catalogue that does not.
    check("a mod with a repo comes from GitHub", by.OnGithub, "github");
    check("otherwise Forge, while it lasts", by.OnlyForge, "forge");
    check("payload bytes are totalled for the confirmation", withEverything.payloadBytes, 5000);

    // After 2026-08-10, or simply offline.
    const noForge = buildSyncPlan(preset, report, { storeConnected: true, forgeAvailable: false });
    const byNoForge = Object.fromEntries(noForge.steps.map((s) => [s.name, s.source]));
    check("payload still works with Forge gone", byNoForge.Carried, "payload");
    check("GitHub still works with Forge gone", byNoForge.OnGithub, "github");
    // Reported, never guessed at.
    check("a Forge-only mod becomes unavailable", byNoForge.OnlyForge, "none");
    check("and is listed as blocked", noForge.blocked.some((b) => b.name === "OnlyForge"), true);
    check("with a reason a person can act on", /Forge is unavailable/.test(noForge.blocked.find((b) => b.name === "OnlyForge").blockedReason), true);

    // The files exist but the folder holding them is not connected — a different problem
    // from "this mod cannot be found", and a different fix.
    const noStore = buildSyncPlan(preset, report, { storeConnected: false, forgeAvailable: false });
    const carried = noStore.steps.find((s) => s.name === "Carried");
    check("a payload with no store connected is blocked", carried.source, "none");
    check("...and says the store is the problem", /store is not connected/.test(carried.blockedReason), true);
  }

  console.log("\nwhat a sync will and will not touch");
  {
    const preset = {
      schema: 1,
      id: "p",
      name: "P",
      createdAt: "",
      updatedAt: "",
      hasPayloads: false,
      mods: [presetMod("Installed"), presetMod("Wrong", { version: "2.0.0" }), presetMod("Off", { enabled: false })]
    };
    const report = makeReport([
      row("Installed", undefined),
      row("Wrong", "version-mismatch", { presetVersion: "2.0.0", localVersion: "1.0.0" }),
      row("Off", "state-mismatch", { presetEnabled: false, localEnabled: true }),
      row("Mine", "extra"),
      row("Unknown", "unknown-version")
    ]);

    const plan = buildSyncPlan(preset, report, { storeConnected: false, forgeAvailable: true });
    const names = plan.steps.map((s) => s.name);
    check("a matching mod needs no step", names.includes("Installed"), false);
    check("a wrong version is updated", names.includes("Wrong"), true);
    check("a wrong on/off state is switched", names.includes("Off"), true);
    // A preset says what a setup needs, not what it forbids. Deleting somebody's mods
    // because they are absent from a list is a far more destructive reading.
    check("a mod the preset does not mention is left alone", names.includes("Mine"), false);
    // "I cannot compare these" is not a reason to redownload anything.
    check("an uncomparable version is not churned", names.includes("Unknown"), false);

    const toggle = plan.steps.find((s) => s.name === "Off");
    check("a toggle needs no source at all", toggle.source, "none");
    check("and knows which way to go", toggle.wantEnabled, false);
    // It is already installed, so it must not be counted as unfixable.
    check("a toggle is never treated as blocked", plan.blocked.some((b) => b.name === "Off"), false);
    check("and is actionable", plan.actionable.some((s) => s.name === "Off"), true);
  }

  console.log("\naddons");
  {
    const preset = {
      schema: 1,
      id: "p",
      name: "P",
      createdAt: "",
      updatedAt: "",
      hasPayloads: true,
      mods: [presetMod("Parent", { payload: "client_Parent@1.0.0" }), presetMod("Elsewhere", { payload: "client_Elsewhere@1.0.0" })]
    };

    // Its parent is being installed from a payload, and the patch lives inside that folder,
    // so the files arrive with it. A separate step would redownload for nothing.
    const carried = buildSyncPlan(
      preset,
      makeReport(
        [row("Parent", "missing")],
        [{ name: "Patch", parentName: "Parent", parentType: "client", mergedIntoParent: true, status: "missing", forgeAddonId: 5 }]
      ),
      { storeConnected: true, forgeAvailable: true }
    );
    check("an addon riding along with its parent needs no step", carried.steps.some((s) => s.reason === "addon-missing"), false);

    // The parent is already installed and only the patch is missing, so it does need one.
    const alone = buildSyncPlan(
      preset,
      makeReport(
        [],
        [{ name: "Patch", parentName: "Parent", parentType: "client", mergedIntoParent: true, status: "missing", forgeAddonId: 5 }]
      ),
      { storeConnected: true, forgeAvailable: true }
    );
    check("a patch missing on its own is installed", alone.counts.addons, 1);
    check("from the catalogue", alone.steps.find((s) => s.reason === "addon-missing").source, "forge");

    // With Forge gone and the files inside a parent that is already present, there is
    // genuinely nothing to fetch — and saying so beats failing later.
    const stuck = buildSyncPlan(
      preset,
      makeReport(
        [],
        [{ name: "Patch", parentName: "Parent", parentType: "client", mergedIntoParent: true, status: "missing", forgeAddonId: 5 }]
      ),
      { storeConnected: true, forgeAvailable: false }
    );
    check("blocked once Forge is gone", stuck.blocked.length, 1);
    check("explaining where its files actually live", /files live inside/.test(stuck.blocked[0].blockedReason), true);

    // Its parent is not installed at all, so patching is meaningless until that changes.
    const noParent = buildSyncPlan(
      preset,
      makeReport(
        [],
        [{ name: "Patch", parentName: "Gone", parentType: "client", mergedIntoParent: true, status: "parent-missing", forgeAddonId: 5 }]
      ),
      { storeConnected: true, forgeAvailable: true }
    );
    check("an addon whose parent is absent is skipped", noParent.steps.length, 0);
  }

  console.log("\nthe summary the user confirms against");
  {
    const empty = buildSyncPlan(
      { schema: 1, id: "p", name: "P", createdAt: "", updatedAt: "", hasPayloads: false, mods: [] },
      makeReport([]),
      { storeConnected: false, forgeAvailable: true }
    );
    check("nothing to do says so", describeSyncPlan(empty), "Nothing to do — this install already matches.");

    const mixed = buildSyncPlan(
      {
        schema: 1,
        id: "p",
        name: "P",
        createdAt: "",
        updatedAt: "",
        hasPayloads: false,
        mods: [
          presetMod("A", { sourceUrl: "https://github.com/x/a" }),
          presetMod("B", {}),
          // No payload, no repo, and Forge is gone — genuinely unobtainable.
          presetMod("Unobtainable", {})
        ]
      },
      makeReport([
        row("A", "missing"),
        row("B", "state-mismatch", { presetEnabled: false }),
        row("Unobtainable", "missing")
      ]),
      { storeConnected: false, forgeAvailable: false }
    );
    const text = describeSyncPlan(mixed);
    check("counts the installs", /install 1 mod/.test(text), true);
    check("counts the switches", /switch 1 on or off/.test(text), true);
    // A toggle needs no source, so it must never be counted among the unobtainable.
    check("the toggle is not miscounted as blocked", mixed.counts.blocked, 1);
    // Never buried: these are the ones the user has to go and get themselves.
    check("and says how many cannot be sourced", /1 cannot be sourced automatically/.test(text), true);
  }

  console.log("\naddons and the headless client");
  {
    // The headless client needs every compatibility patch its main install has, or the pair
    // each patch reconciles breaks on one side only — which shows up as a desync, not as a
    // missing mod, and is correspondingly horrible to diagnose.
    const { buildAddonParity } = require(path.join(dist, "headless.js"));

    const mainMods = [
      { id: "SAIN", type: "client", enabled: true, loadOrder: 1, originalName: "SAIN", name: "SAIN" },
      { id: "WTT-CAG", type: "server", enabled: true, loadOrder: 1, originalName: "WTT-CAG", name: "WTT-CAG" },
      { id: "Solo", type: "client", enabled: true, loadOrder: 1, originalName: "Solo", name: "Solo" }
    ];
    const headlessMods = [{ id: "SAIN", type: "client", enabled: true, loadOrder: 1, originalName: "SAIN", name: "SAIN" }];

    const parity = buildAddonParity(
      [
        { name: "SAIN Patch", parentName: "SAIN", parentType: "client", mergedIntoParent: true },
        { name: "CAG Patch", parentName: "WTT-CAG", parentType: "server", mergedIntoParent: true },
        { name: "Solo Patch", parentName: "Solo", parentType: "client", mergedIntoParent: true },
        { name: "Standalone", parentName: "SAIN", parentType: "client", mergedIntoParent: false }
      ],
      mainMods,
      headlessMods
    );
    const by = Object.fromEntries(parity.map((p) => [p.name, p]));

    // Its parent is on both sides, and the patch lives inside that folder, so syncing the
    // folder carried it. Reported rather than assumed.
    check("a patch inside a synced parent is on both", by["SAIN Patch"].status, "carried-with-parent");
    check("and is needed there", by["SAIN Patch"].needsHeadless, true);

    // Structural, not a preference: a headless client has no server and never reads
    // user/mods, so copying a server patch there would be the appearance of doing something.
    check("a server-side patch is not applicable", by["CAG Patch"].status, "not-applicable");
    check("and is explicitly NOT needed", by["CAG Patch"].needsHeadless, false);
    check("saying why", /no server/.test(by["CAG Patch"].detail), true);

    // The fix is to sync the parent — the patch travels with it — not to hunt for the patch.
    check("a patch whose parent is not synced points at the parent", by["Solo Patch"].status, "parent-missing");
    check("and names it", /Solo/.test(by["Solo Patch"].detail), true);

    // With its own folder it does not ride along, so it cannot simply be assumed present.
    check("a standalone patch needs checking", by["Standalone"].status, "needs-attention");
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
