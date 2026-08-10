/**
 * Server companion detection.
 *
 * The important property is not that detection works when the companion is there — it is that
 * EVERY other outcome reduces to "carry on as before". Almost no server will have this mod,
 * so a manager that errors, or that reports absence as a finding, would be broken against the
 * overwhelming majority of them.
 *
 * The distinction that matters most: a server with no companion is not a server with no
 * client mods. It is a server that cannot be asked. Those must never read the same, because
 * one of them would have someone delete mods they still need.
 */
const path = require("path");
const C = require(path.join(__dirname, "..", "dist-electron", "companion.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== server companion detection ===\n");

console.log("an ordinary SPT server");
{
  // 404 is the CORRECT answer from a server without the mod, and is not an error to report.
  const caps = C.readCapabilities(404, null);
  check("is not treated as present", caps.present, false);
  check("and nothing is claimed about it", [caps.manifest, caps.files], [false, false]);
  check("with no scary reason attached", caps.reason, undefined);
  // The wording must describe a limit on knowledge, not a fact about the server's mods.
  const said = C.describeCapabilities(caps);
  check("the summary says it cannot be asked", /cannot be read from it/.test(said), true);
  check("and does not claim it has none", /no client mods\b/.test(said), false);
}

console.log("\na companion whose routes are broken");
{
  // Measured against a live 4.0.13 server: a route that IS registered but whose action returns
  // null comes back HTTP 200 with this envelope, NOT a 404. An absent route 404s with an empty
  // body and never gets here. Conflating the two would tell somebody to install a mod they
  // already have.
  const caps = C.readCapabilities(200, { err: 404, errmsg: "UNHANDLED RESPONSE: /sptarky/version" });
  check("is not treated as present", caps.present, false);
  check("and says the mod is there but not answering", /installed but its routes are not answering/.test(caps.reason), true);
  check("rather than blaming the contract", /which contract/.test(caps.reason ?? ""), false);
}

console.log("\na companion that answers");
{
  const caps = C.readCapabilities(200, { version: "1.0.0", protocol: 1, capabilities: ["manifest", "files"] });
  check("is present", caps.present, true);
  check("with its version", caps.version, "1.0.0");
  check("offering the manifest", caps.manifest, true);
  check("and file serving", caps.files, true);
  // A 1.0.0 companion. It predates reading versions out of the plugins themselves, so the
  // summary must SAY so and name the fix — otherwise its client rows read "cannot be compared"
  // and the plugins look at fault when the reader is simply not there.
  check("but not client versions", caps.clientVersions, false);
  check(
    "summarised for a person",
    C.describeCapabilities(caps),
    "Server companion 1.0.0 connected — mods and addons, mod files. Its client plugin versions come only from that machine's install records — update the companion to read them from the plugins themselves."
  );
}

console.log("\na companion that reads plugin versions from the DLLs");
{
  const caps = C.readCapabilities(200, { version: "1.1.0", protocol: 1, capabilities: ["manifest", "files", "clientVersions"] });
  check("declares the capability", caps.clientVersions, true);
  // Asked about BY NAME rather than inferred from "1.1.0 >= the version that added it", so this
  // stays right regardless of which order the routes ship in.
  check("and the summary stops nagging about it", /update the companion/.test(C.describeCapabilities(caps)), false);
}

console.log("\ncapabilities are asked about by name, not inferred");
{
  // A companion may ship one before the other; this must not have to know release history.
  const partial = C.readCapabilities(200, { version: "0.9.0", protocol: 1, capabilities: ["manifest"] });
  check("manifest only", [partial.manifest, partial.files], [true, false]);
  const none = C.readCapabilities(200, { version: "0.1.0", protocol: 1, capabilities: [] });
  check("a companion offering nothing is still present", none.present, true);
  check("and says so plainly", /offers nothing this manager uses/.test(C.describeCapabilities(none)), true);
}

console.log("\nrefusing what cannot be understood");
{
  // Newer contract: guessing at fields whose meaning may have changed is worse than stopping,
  // and the message names the fix instead of failing obscurely somewhere later.
  const newer = C.readCapabilities(200, { version: "2.0.0", protocol: C.COMPANION_PROTOCOL + 1, capabilities: ["manifest"] });
  check("a newer contract is not used", newer.present, false);
  check("but the version is kept for the message", newer.version, "2.0.0");
  check("and it names the fix", /Update the manager/.test(newer.reason ?? ""), true);

  const noProtocol = C.readCapabilities(200, { version: "1.0.0", capabilities: ["manifest"] });
  check("an answer with no contract is refused", noProtocol.present, false);
}

console.log("\neverything else degrades quietly");
{
  check("500 is not present", C.readCapabilities(500, null).present, false);
  check("and says what happened", /answered 500/.test(C.readCapabilities(500, null).reason ?? ""), true);
  check("unreachable is not present", C.readCapabilities(0, null).present, false);
  check("a non-object body is refused", C.readCapabilities(200, "hello").present, false);
  check("null body is refused", C.readCapabilities(200, null).present, false);

  // A token is required and this manager has none: a different problem from absence, with a
  // different fix, so it is reported differently.
  const denied = C.readCapabilities(401, null);
  check("unauthorised is flagged", denied.unauthorised, true);
  check("not present", denied.present, false);
  check("and names the cause", /token/.test(denied.reason ?? ""), true);
  check("403 is treated the same", C.readCapabilities(403, null).unauthorised, true);
}

/* ------------------------------------------------------------------------------------------ *
 * The manifest — reconciling what the server reports against what its ledger recorded.
 * ------------------------------------------------------------------------------------------ */

// Trimmed from a REAL response captured off a live 4.0.13 server, not invented. WTT-Artem is
// the case the companion exists for: it declares 3.0.0 forever because its author never bumped
// the manifest, while 3.0.1 is what is on disk.
const liveish = {
  protocol: 1,
  companionVersion: "1.0.0",
  serverRootFound: true,
  clientRootFound: true,
  split: true,
  serverMods: [
    { folder: "WTT-Artem", guid: "com.crackbone.artem-wtt", declaredVersion: "3.0.0", loaded: true, enabled: true },
    { folder: "fika-server", guid: "Fika", declaredVersion: "2.3.5", loaded: true, enabled: true },
    { folder: "tacticaltoaster-untargohome", loaded: false, enabled: false }
  ],
  clientMods: [
    { name: "DrakiaXYZ-BigBrain.dll", kind: "file", area: "plugins", enabled: true },
    { name: "AmandsGraphics", kind: "folder", area: "plugins", enabled: true }
  ],
  registryJson: JSON.stringify([
    { id: "WTT-Artem", type: "server", installedVersion: "3.0.1", versionOrigin: "forge" },
    // Note the ".dll": checked against the live registry, a loose client plugin is stored under
    // its full filename. An earlier version of this fixture dropped the extension and made a
    // broken lookup look correct.
    { id: "DrakiaXYZ-BigBrain.dll", type: "client", installedVersion: "1.4.0", versionOrigin: "forge" },
    { id: "AmandsGraphics", type: "client", installedVersion: "1.7.0", versionOrigin: "forge" }
  ]),
  addonsJson: JSON.stringify([{ id: "some-addon", addonOf: "WTT-Artem" }]),
  warnings: []
};

console.log("\nthe manifest, reconciled");
{
  const m = C.readManifest(liveish);
  const artem = m.serverMods.find((x) => x.id === "WTT-Artem");
  // The whole reason the companion exists.
  check("the ledger beats what the mod declares", artem.version, "3.0.1");
  check("and the declared version is kept for showing the disagreement", artem.declaredVersion, "3.0.0");
  check("with its source named, not guessed", artem.versionSource, "ledger");

  const fika = m.serverMods.find((x) => x.id === "fika-server");
  check("a mod the ledger never recorded falls back to declared", fika.version, "2.3.5");
  check("and says so rather than implying it was recorded", fika.versionSource, "declared");

  const broken = m.serverMods.find((x) => x.id === "tacticaltoaster-untargohome");
  check("a disabled mod is reported, not dropped", broken !== undefined, true);
  check("as not enabled", broken.enabled, false);
  check("and as having failed to load", broken.failedToLoad, true);

  // A loose client plugin keeps its ".dll", because that is how the registry stores it.
  const bb = m.clientMods.find((x) => x.id === "DrakiaXYZ-BigBrain.dll");
  check("a loose client dll keeps its extension as its identity", bb !== undefined, true);
  check("and matches the ledger entry stored under that name", bb.version, "1.4.0");
  const folderMod = m.clientMods.find((x) => x.id === "AmandsGraphics");
  check("a folder plugin matches too", folderMod.version, "1.7.0");
  check("addons come through", m.addons.length, 1);
  check("and that the ledger existed at all is recorded", m.addonsKnown, true);
  check("the client half is known", m.clientKnown, true);
  check("and versions are not declared-only", m.versionsAreDeclaredOnly, false);
}

console.log("\nclient plugin versions read from the DLL, for plugins no ledger covers");
{
  /*
   * The gap this closes, taken from two real machines. Neither had a registry entry for
   * `com.swiftxp.spt.showmethemoney.quicksell` — it was installed by hand — yet the local scan
   * reported 2.3.0, because the manager reads [BepInPlugin] out of the assembly. The companion
   * could not, so the row was permanently "cannot be compared" and no amount of reinstalling
   * would have fixed it.
   *
   * `showmethemoney` sits beside it deliberately: the two are SEPARATE mods whose names share a
   * prefix, so anything that resolved a missing version from a similarly-named sibling would
   * report 2.7.0 here and be confidently wrong.
   */
  const m = C.readManifest({
    ...liveish,
    clientMods: [
      {
        name: "com.swiftxp.spt.showmethemoney.quicksell",
        kind: "folder",
        area: "plugins",
        enabled: true,
        guid: "com.swiftxp.spt.showmethemoney.quicksell",
        displayName: "Quick Sell",
        declaredVersion: "2.3.0",
        assemblyVersion: "2.3.0"
      },
      {
        name: "com.swiftxp.spt.showmethemoney",
        kind: "folder",
        area: "plugins",
        enabled: true,
        guid: "com.swiftxp.spt.showmethemoney",
        declaredVersion: "2.7.0"
      },
      // Declared 1.2.1 while the compiled assembly still says 1.0.0 — a real pair, and the
      // reason the assembly version may never outrank a declared one.
      { name: "BlackDiv", kind: "folder", area: "plugins", enabled: true, declaredVersion: "1.2.1", assemblyVersion: "1.0.0" },
      // Nothing declared at all. The assembly's own version is the only thing left.
      { name: "Tyfon.UIFixes.Net.dll", kind: "file", area: "plugins", enabled: true, assemblyVersion: "5.3.11" }
    ],
    registryJson: JSON.stringify([])
  });

  const quicksell = m.clientMods.find((x) => x.id === "com.swiftxp.spt.showmethemoney.quicksell");
  check("a hand-installed plugin now has a version", quicksell.version, "2.3.0");
  check("attributed to the mod's own declaration", quicksell.versionSource, "declared");
  check("its GUID travels too, which is what makes a catalogue lookup exact", quicksell.guid, "com.swiftxp.spt.showmethemoney.quicksell");
  check("as does the name the author published under", quicksell.displayName, "Quick Sell");

  // The similarly-named sibling keeps its own version. If these ever converge, the prefix
  // shortcut has crept back in.
  check("a similarly named mod is NOT confused with it", m.clientMods.find((x) => x.id === "com.swiftxp.spt.showmethemoney").version, "2.7.0");

  const blackdiv = m.clientMods.find((x) => x.id === "BlackDiv");
  check("a stale assembly version never outranks a declared one", blackdiv.version, "1.2.1");
  check("and is not passed off as the declaration", blackdiv.versionSource, "declared");

  const helper = m.clientMods.find((x) => x.id === "Tyfon.UIFixes.Net.dll");
  check("with nothing declared, the assembly version is used", helper.version, "5.3.11");
  check("and is named as the weaker source it is", helper.versionSource, "assembly");
}

console.log("\nan install with no addon records");
{
  // Absent and empty must not reduce to the same thing. A machine that has never installed an
  // addon through this manager has no ledger, and "the server has no addons" is a claim that
  // cannot be made from a file that does not exist — addons mostly unpack into their parent and
  // leave nothing on disk to notice.
  const none = C.readManifest({ ...liveish, addonsJson: null });
  check("no ledger means unknown", none.addonsKnown, false);
  check("with an empty list rather than a guess", none.addons.length, 0);

  const empty = C.readManifest({ ...liveish, addonsJson: "[]" });
  check("an EMPTY ledger is a real answer, not an absent one", empty.addonsKnown, true);
  check("and still has nothing in it", empty.addons.length, 0);
}

console.log("\nwhat a server-only box reports");
{
  // No BepInEx beside the server. The client list is empty BECAUSE UNKNOWN.
  const m = C.readManifest({ ...liveish, clientRootFound: false, clientMods: [], warnings: ["No BepInEx folder was found beside the server, so client mods cannot be read from this machine."] });
  check("client mods are empty", m.clientMods.length, 0);
  // The flag is the whole point: an empty list plus clientKnown:false must never be read as
  // "the server has no client mods", which is what would have someone delete mods they need.
  check("but that is flagged as unknown, not as none", m.clientKnown, false);
  check("and the reason survives for the UI", /cannot be read/.test(m.warnings[0]), true);
}

console.log("\ndegrading without losing the useful part");
{
  const m = C.readManifest({ ...liveish, registryJson: "{ this is not json" });
  check("a corrupt ledger does not lose the mod list", m.serverMods.length, 3);
  check("versions fall back to declared", m.serverMods.find((x) => x.id === "WTT-Artem").version, "3.0.0");
  check("and it is marked declared-only", m.versionsAreDeclaredOnly, true);
  check("with the cause reported", m.warnings.some((w) => /ledger could not be read/.test(w)), true);

  const noLedger = C.readManifest({ ...liveish, registryJson: null });
  check("no ledger at all is also declared-only", noLedger.versionsAreDeclaredOnly, true);

  check("a body that is not a manifest is refused", C.readManifest({ hello: 1 }), null);
  check("as is null", C.readManifest(null), null);
}


console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
