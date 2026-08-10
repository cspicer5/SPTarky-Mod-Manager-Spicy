/**
 * The three-way comparison against a live server: server mods, client plugins, addons.
 *
 * This function had no unit test until it compared three things instead of one, and the bugs it
 * has produced were all of the same kind — reporting a difference that was not there. Each is
 * pinned below, because every one of them was found against real machines rather than by
 * reading the code, and none would have shown up as an exception:
 *
 *   - a plugin shipping as BOTH `Mod.dll` and `Mod/` counted twice, once on each side
 *   - prepatchers listed individually on the server, folded into their parent locally, so four
 *     mods sitting on disk were reported missing
 *   - the companion itself compared as a mod, which it never is
 *   - an addon carrying a Forge id on one machine and not the other, matched as two addons
 *
 * The governing rule, and the reason for most of the checks: an empty list from a machine that
 * COULD NOT BE ASKED must never be compared against. Undefined means unknown; only a real answer
 * may produce "the server does not have this".
 */
const path = require("path");
const { buildServerSyncReport } = require(path.join(__dirname, "..", "dist-electron", "sptServer.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const localMod = (over) => ({
  id: over.id,
  name: over.name ?? over.id,
  originalName: over.originalName ?? over.id,
  type: over.type ?? "client",
  enabled: true,
  installedManually: false,
  loadOrder: 0,
  ...over
});

const snapshot = (over) => ({
  url: "https://192.168.1.78:6969",
  reachable: true,
  sptVersion: "4.0.13",
  mods: [],
  fikaRequired: [],
  fikaOptional: [],
  fetchedAt: "2026-08-10T00:00:00.000Z",
  companion: { present: true, manifest: true, files: true, clientVersions: true, version: "1.1.0" },
  ...over
});

const remoteClient = (over) => ({ type: "client", enabled: true, versionSource: "declared", area: "plugins", ...over });

const rowFor = (report, key) => report.rows.find((r) => r.key === key);

console.log("\n=== server sync: server, client and addons ===\n");

console.log("without a companion, only server mods are compared");
{
  // The client half is UNDEFINED, not empty. Folding local plugins in here would report every
  // one of them as "not on server" — a confident claim built on having no information at all.
  const report = buildServerSyncReport(
    snapshot({ companion: { present: false, manifest: false, files: false, clientVersions: false }, mods: [{ name: "WTT-Artem", modGuid: "com.crackbone.artem-wtt", version: "3.0.1" }] }),
    [localMod({ id: "WTT-Artem", type: "server", guid: "com.crackbone.artem-wtt", version: "3.0.1" }), localMod({ id: "SAIN", version: "4.4.3" })]
  );
  check("the server mod is in sync", report.counts.inSync, 1);
  check("and the local plugin is not reported at all", report.rows.some((r) => r.side === "client"), false);
  check("addons were not compared either", report.addonsCompared, false);
}

console.log("\nclient plugins, once a companion can report them");
{
  const report = buildServerSyncReport(
    snapshot({
      clientMods: [
        { id: "SAIN", type: "client", version: "4.4.3", versionSource: "declared", guid: "me.sol.sain", enabled: true, area: "plugins" },
        // Ships as a loose dll AND a folder. One mod, two entries — collapsing them is what
        // stopped BlackDiv appearing twice against the real server.
        { id: "BlackDiv.dll", type: "client", version: "1.2.1", versionSource: "declared", enabled: true, area: "plugins", guid: "com.blackdiv.tacticaltoaster" },
        { id: "BlackDiv", type: "client", versionSource: "unknown", enabled: true, area: "plugins" },
        // A prepatcher. The local scanner folds these into their parent and never lists them,
        // so comparing them standalone reports mods as missing that are sitting on disk.
        { id: "UNTARGHPrepatch.dll", type: "client", version: "3.1.1", versionSource: "declared", enabled: true, area: "patchers" },
        // SPT's own file. Nobody installs or removes it.
        { id: "spt", type: "client", version: "4.0.13", versionSource: "declared", enabled: true, area: "plugins" }
      ]
    }),
    [
      localMod({ id: "SAIN", version: "4.0.0" }),
      localMod({ id: "BlackDiv.dll", version: "1.2.1" }),
      localMod({ id: "BlackDiv" })
    ]
  );

  check("an outdated plugin is caught", rowFor(report, "client:sain").issue, "outdated-locally");
  check("with both versions shown", rowFor(report, "client:sain").detail, "The server machine has 4.4.3; you have 4.0.0.");
  check("the dll and its folder collapse to ONE row", report.rows.filter((r) => r.key === "client:blackdiv").length, 1);
  check("and it is in sync rather than half-missing", rowFor(report, "client:blackdiv").issue, undefined);
  check("patchers are left out entirely", report.rows.some((r) => /untargh/i.test(r.key)), false);
  check("as is SPT's own plugin folder", report.rows.some((r) => r.key === "client:spt"), false);
  check("nothing is invented as missing", report.counts.needInstalling, 0);
}

console.log("\nwhat makes a row fetchable");
{
  /*
   * The distinction this pins down cost a wrong implementation to find. There are TWO kinds of
   * GUID in play and they are not interchangeable:
   *
   *   catalogueGuid  identifies the PACKAGE, recorded by that machine's manager at install
   *                  time. This is what a catalogue lookup understands.
   *   guid           identifies ONE ASSEMBLY, read from [BepInPlugin].
   *
   * They frequently differ — `Tyfon.UIFixes.dll` declares `Tyfon.UIFixes` while its catalogue
   * id is `com.tyfon.uifixes` — so passing the assembly's as if it were the catalogue's is a
   * lookup that matches whatever happens to share the string.
   */
  const report = buildServerSyncReport(
    snapshot({
      clientMods: [
        {
          id: "QuickSell",
          type: "client",
          version: "2.3.0",
          versionSource: "ledger",
          guid: "com.swiftxp.spt.showmethemoney.quicksell",
          catalogueGuid: "com.swiftxp.showmethemoney",
          displayName: "Quick Sell",
          enabled: true,
          area: "plugins"
        },
        // Declares itself perfectly well, but the server installed it BY HAND — so no catalogue
        // record exists and there is nothing safe to look it up with.
        {
          id: "HandInstalled",
          type: "client",
          version: "1.0.0",
          versionSource: "declared",
          guid: "com.someone.handinstalled",
          enabled: true,
          area: "plugins"
        },
        // Nothing at all beyond a file name, load-order prefix and all.
        { id: "01-SomeHelper.dll", type: "client", version: "1.0.0", versionSource: "assembly", enabled: true, area: "plugins" }
      ]
    }),
    []
  );

  const quicksell = rowFor(report, "client:quicksell");
  check("a plugin with a catalogue record can be installed", quicksell.installable, true);
  check("under the name its author published", quicksell.name, "Quick Sell");
  check("and it is the CATALOGUE id that travels, not the assembly's", quicksell.guid, "com.swiftxp.showmethemoney");

  // The guard. An assembly GUID looks like a perfectly good identifier and is the wrong one;
  // accepting it here is how a lookup lands on a different mod.
  const byHand = rowFor(report, "client:handinstalled");
  check("a [BepInPlugin] GUID alone does NOT make a row fetchable", byHand.installable, false);
  check("and the reason names where the gap is", /installed by hand there/.test(byHand.notInstallableReason), true);

  // The load-order prefix is stripped from the KEY, so "01-SomeHelper.dll" and "SomeHelper"
  // are the same plugin — but a name is still not enough to fetch one by.
  const helper = rowFor(report, "client:somehelper");
  check("nor does a bare file name", helper.installable, false);

  // The side door: on an OUTDATED row the local mod is present, and its GUID is
  // catalogue-first with an assembly-GUID plan B. A plugin installed by hand on BOTH machines
  // therefore offers a [BepInPlugin] GUID from the local side, and accepting it would put the
  // wrong namespace straight back into the lookup.
  const outdated = buildServerSyncReport(
    snapshot({
      clientMods: [{ id: "HandBoth", type: "client", version: "2.0.0", versionSource: "declared", guid: "com.someone.handboth", enabled: true, area: "plugins" }]
    }),
    [localMod({ id: "HandBoth", guid: "com.someone.handboth", version: "1.0.0" })]
  );
  const row = rowFor(outdated, "client:handboth");
  check("an outdated hand-installed plugin is still caught", row.issue, "outdated-locally");
  check("but the local assembly GUID does not make it fetchable", row.installable, false);
}

console.log("\nclient plugins are matched by name, never across GUID namespaces");
{
  /*
   * The fault this guards against, measured on the reference install: HollywoodFX 2.0.0 is ONE
   * catalogue package that installs TWO plugin folders, so locally both `HollywoodFX` and
   * `HollywoodGraphics` carry `com.janky.hollywoodfx`. Remotely each declares its own assembly
   * GUID. Matching local-catalogue against remote-assembly made remote `HollywoodFX` match both
   * local folders, and it picked one by version order — which agreed, so the report looked
   * right while the matching was not.
   */
  const report = buildServerSyncReport(
    snapshot({
      clientMods: [
        { id: "HollywoodFX", type: "client", version: "2.0.0", versionSource: "declared", guid: "com.janky.hollywoodfx", enabled: true, area: "plugins" },
        { id: "HollywoodGraphics", type: "client", version: "2.0.0", versionSource: "declared", guid: "com.janky.hollywoodgraphics", enabled: true, area: "plugins" }
      ]
    }),
    [
      // Both local folders share the packaging GUID, exactly as the registry records them.
      localMod({ id: "HollywoodFX", guid: "com.janky.hollywoodfx", version: "2.0.0" }),
      localMod({ id: "HollywoodGraphics", guid: "com.janky.hollywoodfx", version: "2.0.0" })
    ]
  );

  check("each folder gets its own row", report.rows.filter((r) => r.side === "client").length, 2);
  check("matched to the folder of the same name", rowFor(report, "client:hollywoodgraphics").localModId, "HollywoodGraphics");
  check("and not to its packaging sibling", rowFor(report, "client:hollywoodfx").localModId, "HollywoodFX");
  // Said honestly. These ARE name matches, and labelling them as GUID matches would present a
  // weaker method with more confidence than it has earned.
  check("reported as the name matches they are", rowFor(report, "client:hollywoodfx").matchedBy, "name");
  check("with nothing invented on either side", [report.counts.needInstalling, report.counts.notOnServer], [0, 0]);
}

console.log("\naddons, which only a ledger can see");
{
  const report = buildServerSyncReport(
    snapshot({
      addons: [
        { forgeAddonId: 42, name: "CAG BRNVG patch", version: "1.1.0", parentName: "BorkelRNVG" },
        { name: "hand-made patch", version: "1.0.0", parentName: "SAIN" },
        { forgeAddonId: 7, name: "shared", version: "2.0.0", parentName: "WTT-Artem" }
      ]
    }),
    [],
    undefined,
    [
      { forgeAddonId: 42, name: "CAG BRNVG patch", version: "1.0.0", parentName: "BorkelRNVG" },
      // Same addon as the server's id-7 entry, but installed from a FILE here so it carries no
      // Forge id. Keying on the id alone would make this two addons: one missing, one extra.
      { name: "shared", version: "2.0.0", parentName: "WTT-Artem" },
      { name: "only here", version: "1.0.0", parentName: "SAIN" }
    ]
  );

  check("the comparison happened", report.addonsCompared, true);

  const brnvg = rowFor(report, "addon:id:42");
  check("an out-of-date addon is caught", brnvg.issue, "outdated-locally");
  check("named against the mod it patches", brnvg.detail, "The server has 1.1.0 of this BorkelRNVG patch; you have 1.0.0.");
  check("and is installable, because it has a catalogue id", brnvg.installable, true);

  const handMade = rowFor(report, "addon:n:hand-made patch|sain");
  check("one the server installed by hand is reported missing", handMade.issue, "missing-locally");
  check("but not offered as a download, since there is nothing to fetch", handMade.installable, false);
  check("with the parent named so it can be found", /SAIN/.test(handMade.notInstallableReason), true);

  check("an addon with an id on one side only still matches", report.rows.filter((r) => /shared/.test(r.name)).length, 1);
  check("and is in sync", report.rows.find((r) => /shared/.test(r.name)).issue, undefined);

  const localOnly = rowFor(report, "addon:n:only here|sain");
  check("a local-only addon is reported the other way round", localOnly.issue, "not-on-server");
  check("every addon row is labelled as one", report.rows.filter((r) => r.side === "addon").length, 4);
}

console.log("\naddons when one machine has no records");
{
  // Not a fault — plenty of people install addons by hand — but it must not be compared. Most
  // addons unpack INTO their parent's folder, so there is nothing on disk to check against and
  // the ledger is the only evidence they exist.
  const noRemote = buildServerSyncReport(snapshot({}), [], undefined, [{ name: "x", version: "1", parentName: "y" }]);
  check("no server ledger means no addon rows", noRemote.rows.some((r) => r.side === "addon"), false);
  check("and it is flagged, not silently skipped", noRemote.addonsCompared, false);

  const noLocal = buildServerSyncReport(snapshot({ addons: [{ name: "x", version: "1", parentName: "y" }] }), [], undefined, undefined);
  check("no local ledger, same answer", noLocal.rows.some((r) => r.side === "addon"), false);
  check("also flagged", noLocal.addonsCompared, false);

  // EMPTY is a real answer, unlike undefined: this machine genuinely has no addons, so the
  // server's are legitimately missing here.
  const emptyLocal = buildServerSyncReport(snapshot({ addons: [{ forgeAddonId: 9, name: "x", version: "1", parentName: "y" }] }), [], undefined, []);
  check("an empty local ledger IS compared", emptyLocal.addonsCompared, true);
  check("and the server's addon shows as missing", rowFor(emptyLocal, "addon:id:9").issue, "missing-locally");
}

console.log("\nthe companion is never compared as a mod");
{
  // It is infrastructure this manager installs, and whether a machine has it is a per-machine
  // decision — the server needs it, a plain client does not. Comparing the two produces a
  // difference that is always expected and never actionable.
  const report = buildServerSyncReport(
    snapshot({ mods: [{ name: "SptarkyCompanion", modGuid: "com.sptarky.companion", version: "1.1.0" }] }),
    [localMod({ id: "SptarkyCompanion", type: "server", guid: "com.sptarky.companion", version: "1.1.0" })]
  );
  check("it produces no row at all", report.rows.length, 0);
}

console.log("\nreadiness");
{
  const behind = buildServerSyncReport(
    snapshot({ clientMods: [{ id: "SAIN", type: "client", version: "4.4.3", versionSource: "declared", guid: "me.sol.sain", enabled: true, area: "plugins" }] }),
    [localMod({ id: "SAIN", version: "4.0.0" })],
    "4.0.13"
  );
  // A client plugin behind the server's counts against readiness exactly as a server mod does —
  // that is the point of comparing all three halves in one place.
  check("an outdated client plugin blocks readiness", behind.readyToPlay, false);

  const ahead = buildServerSyncReport(
    snapshot({ clientMods: [{ id: "SAIN", type: "client", version: "4.0.0", versionSource: "declared", guid: "me.sol.sain", enabled: true, area: "plugins" }] }),
    [localMod({ id: "SAIN", version: "4.4.3" })],
    "4.0.13"
  );
  // Being AHEAD is a mismatch worth showing but not one that stops you playing, and "matching"
  // it would mean rolling your own install backwards.
  check("being newer than the server does not", ahead.readyToPlay, true);
  check("though it is still reported", ahead.counts.newerLocally, 1);
}

console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
