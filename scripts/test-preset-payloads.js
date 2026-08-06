/**
 * Preset payloads — phase 3.
 *
 * These are the tests worth having, because the failure modes all LOOK like success:
 *
 *  - a payload that died halfway through a 4.7 GB copy appears complete in a folder listing
 *  - two different builds calling themselves the same version silently share one payload,
 *    so one person's preset ships another person's files
 *  - a split install puts the server half where nothing ever reads it
 *  - a disabled mod needs a second, byte-identical payload unless the layout is normalised
 *
 * Everything happens in a temp directory; no real store or install is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const P = require(path.join(dist, "presetPayloads.js"));
const S = require(path.join(dist, "presetStore.js"));
const { createPreset } = require(path.join(dist, "presets.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-payload-"));
const STORE = path.join(root, "store");
const LOCAL = path.join(root, "local");

/** A SPLIT install: client and server roots differ, as the SPT 4.x installer can produce. */
const CLIENT = path.join(root, "install");
const SERVER = path.join(root, "install", "SPT_Runtime");

const w = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function buildInstall() {
  // A client mod in a folder, with a prepatcher and a BepInEx config.
  w(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll"), "sain-binary");
  w(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "data", "presets.json"), '{"preset":"default"}');
  w(path.join(CLIENT, "BepInEx", "patchers", "SAIN.Prepatch.dll"), "sain-prepatch");
  w(path.join(CLIENT, "BepInEx", "config", "me.sol.sain.cfg"), "[General]\nEnabled = true");

  // A loose DLL that owns a companion folder of the same name.
  w(path.join(CLIENT, "BepInEx", "plugins", "Wedge.dll"), "wedge-binary");
  w(path.join(CLIENT, "BepInEx", "plugins", "Wedge", "assets.bundle"), "wedge-assets");

  // A server mod, under the SERVER root — the split that matters.
  w(path.join(SERVER, "user", "mods", "fika-server", "package.json"), '{"name":"fika-server","version":"2.0.9"}');
  w(path.join(SERVER, "user", "mods", "fika-server", "src", "mod.js"), "// server code");

  // A client mod that is DISABLED, so it lives in plugins.disabled.
  w(path.join(CLIENT, "BepInEx", "plugins.disabled", "Waypoints", "Waypoints.dll"), "waypoints-binary");
}

const mod = (id, type, enabled = true, extra = {}) => ({
  id,
  originalName: id,
  name: id.replace(/\.dll$/i, ""),
  type,
  enabled,
  loadOrder: 1,
  ...extra
});

async function main() {
  buildInstall();
  fs.mkdirSync(STORE, { recursive: true });
  fs.mkdirSync(LOCAL, { recursive: true });
  await S.initStore(STORE, { name: "Payload Store", owner: "cspicer5", writePolicy: "shared" });

  console.log("gathering a mod's complete file set");
  {
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("SAIN", "client", true, { guid: "me.sol.sain" }));
    const rels = files.map((f) => f.rel).sort();
    check("found every part", rels.length, 4);
    check("the plugin", rels.includes("BepInEx/plugins/SAIN/SAIN.dll"), true);
    check("its data folder", rels.includes("BepInEx/plugins/SAIN/data/presets.json"), true);
    // A mod split across plugins/ and patchers/ is half-installed without the prepatcher —
    // the same reasoning as the toggle cascade.
    check("the prepatcher", rels.includes("BepInEx/patchers/SAIN.Prepatch.dll"), true);
    // Without the config the receiving install runs the right mod with default settings,
    // which looks like the mod misbehaving rather than like a missing file.
    check("the BepInEx config, found by GUID", rels.includes("BepInEx/config/me.sol.sain.cfg"), true);
  }
  {
    // "Wedge.dll" owns "Wedge/". Copying only the DLL leaves the plugin loading against
    // nothing.
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("Wedge.dll", "client"));
    const rels = files.map((f) => f.rel).sort();
    check("loose dll captured", rels.includes("BepInEx/plugins/Wedge.dll"), true);
    check("and its companion folder", rels.includes("BepInEx/plugins/Wedge/assets.bundle"), true);
  }
  {
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("fika-server", "server"));
    check("server mod read from the SERVER root", files.length, 2);
    check("recorded under user/mods", files.every((f) => f.rel.startsWith("user/mods/fika-server/")), true);
  }
  {
    // Stored in the ENABLED layout wherever it currently sits. Otherwise a preset that ships
    // a mod deliberately disabled needs a second, byte-identical payload — defeating the
    // deduplication that makes 17.8 GB viable at all.
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("Waypoints", "client", false));
    check("a disabled mod is still found", files.length, 1);
    check("but recorded in the enabled layout", files[0].rel, "BepInEx/plugins/Waypoints/Waypoints.dll");
  }

  console.log("\nstoring a payload");
  let sainKey;
  {
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("SAIN", "client", true, { guid: "me.sol.sain" }));
    const r = await P.storePayload(STORE, files, { name: "SAIN", version: "4.4.3", type: "client" });
    check("stored", r.success, true);
    check("keyed by side, name and version", r.key, "client_SAIN@4.4.3");
    check("nothing reused on a first store", r.reused, false);
    sainKey = r.key;

    const manifest = await P.readPayloadManifest(STORE, sainKey);
    check("manifest written", manifest?.files, 4);
    check("with a content hash", typeof manifest?.hash === "string" && manifest.hash.length === 64, true);
    // Layout mirrors the install, so applying is a copy rather than a transformation.
    check(
      "payload mirrors the install layout",
      fs.existsSync(path.join(STORE, "mods", sainKey, "BepInEx", "plugins", "SAIN", "SAIN.dll")),
      true
    );
    check("staging cleaned up", fs.existsSync(path.join(STORE, "mods", ".staging", sainKey)), false);
  }

  console.log("\nstoring the identical mod again costs nothing");
  {
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("SAIN", "client", true, { guid: "me.sol.sain" }));
    const r = await P.storePayload(STORE, files, { name: "SAIN", version: "4.4.3", type: "client" });
    check("succeeded", r.success, true);
    // Deduplication is mandatory, not an optimisation: a second preset sharing 90% of its
    // mods must cost only the remaining 10%.
    check("recognised as already stored", r.reused, true);
    check("no bytes copied", r.bytesCopied, 0);
    check("same key", r.key, sainKey);
  }

  console.log("\na DIFFERENT build claiming the same version");
  {
    // The exact reason the key carries a hash. fika-server declares 2.0.9 whichever build you
    // have; if two people publish different builds as SAIN@4.4.3, the second must not
    // silently ship the first person's files.
    w(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll"), "sain-binary-DIFFERENT-BUILD");
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("SAIN", "client", true, { guid: "me.sol.sain" }));
    const r = await P.storePayload(STORE, files, { name: "SAIN", version: "4.4.3", type: "client" });
    check("stored separately", r.success, true);
    check("did NOT reuse the other build", r.reused, false);
    check("key disambiguated by hash", r.key !== sainKey, true);
    check("and still readable", /^client_SAIN@4\.4\.3\+[0-9a-f]{8}$/.test(r.key), true);

    const original = await P.readPayloadManifest(STORE, sainKey);
    const theOther = await P.readPayloadManifest(STORE, r.key);
    check("the original is untouched", original.hash !== theOther.hash, true);
    check(
      "the original's bytes are still the original's",
      fs.readFileSync(path.join(STORE, "mods", sainKey, "BepInEx", "plugins", "SAIN", "SAIN.dll"), "utf-8"),
      "sain-binary"
    );

    w(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll"), "sain-binary"); // restore
  }

  console.log("\none folder name, a server half AND a client half");
  {
    // Real shape, not hypothetical: acidphantasm-botplacementsystem, WTT-PackNStrap and
    // showmethemoney all do this on the reference install. Keying on name and version alone
    // puts two different mods at one address. The hash suffix would keep them apart in
    // practice, but only because their contents happen to differ — making a structural
    // distinction depend on a coincidence is how the headless parity report once let server
    // rows overwrite client rows.
    w(path.join(CLIENT, "BepInEx", "plugins", "botplacement", "client.dll"), "same-bytes");
    w(path.join(SERVER, "user", "mods", "botplacement", "server.js"), "same-bytes");

    const clientHalf = P.collectModPayloadFiles(CLIENT, SERVER, mod("botplacement", "client"));
    const serverHalf = P.collectModPayloadFiles(CLIENT, SERVER, mod("botplacement", "server"));

    const c = await P.storePayload(STORE, clientHalf, { name: "botplacement", version: "1.0.0", type: "client" });
    const s = await P.storePayload(STORE, serverHalf, { name: "botplacement", version: "1.0.0", type: "server" });

    check("client half stored", c.key, "client_botplacement@1.0.0");
    check("server half stored", s.key, "server_botplacement@1.0.0");
    check("no hash suffix needed — the keys never collided", s.key.includes("+"), false);
    check("the server half did not reuse the client half", s.reused, false);

    // And each still lands in the right place, which is the point.
    const T = path.join(root, "target-bothhalves");
    const TS = path.join(T, "SPT_Runtime");
    fs.mkdirSync(T, { recursive: true });
    await P.applyPayload(STORE, c.key, T, TS, { enabled: true });
    await P.applyPayload(STORE, s.key, T, TS, { enabled: true });
    check("client half in BepInEx", fs.existsSync(path.join(T, "BepInEx", "plugins", "botplacement", "client.dll")), true);
    check("server half in user/mods on the server root", fs.existsSync(path.join(TS, "user", "mods", "botplacement", "server.js")), true);
  }

  console.log("\nverifying");
  {
    const shallow = await P.verifyPayload(STORE, sainKey);
    check("a complete payload passes", shallow.ok, true);
    check("shallow by default", shallow.depth, "shallow");

    const deep = await P.verifyPayload(STORE, sainKey, true);
    check("and passes a deep check too", deep.ok, true);
    check("which re-hashed everything", deep.depth, "deep");
    check("hashes agree", deep.actualHash, deep.expectedHash);
  }
  {
    // A copy that died partway leaves a folder that LOOKS complete. This is the failure the
    // shallow check exists to catch.
    const wounded = path.join(STORE, "mods", "Wounded@1.0.0");
    fs.mkdirSync(path.join(wounded, "BepInEx", "plugins"), { recursive: true });
    w(path.join(wounded, "BepInEx", "plugins", "a.dll"), "aaa");
    fs.writeFileSync(
      path.join(wounded, "payload.json"),
      JSON.stringify({ schema: 1, key: "Wounded@1.0.0", name: "Wounded", type: "client", hash: "x", files: 5, bytes: 999 })
    );
    const v = await P.verifyPayload(STORE, "Wounded@1.0.0");
    check("an incomplete payload is caught", v.ok, false);
    check("and says what is missing", /expected 5 files/.test(v.message), true);
  }
  {
    // Silent corruption: right file count, right sizes, wrong bytes. Only a deep check sees it.
    const target = path.join(STORE, "mods", sainKey, "BepInEx", "plugins", "SAIN", "SAIN.dll");
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.alloc(original.length, 0x41));
    check("shallow check still passes (same size)", (await P.verifyPayload(STORE, sainKey)).ok, true);
    check("deep check catches it", (await P.verifyPayload(STORE, sainKey, true)).ok, false);
    fs.writeFileSync(target, original);
    check("restored", (await P.verifyPayload(STORE, sainKey, true)).ok, true);
  }

  console.log("\nresuming an interrupted copy");
  {
    // 17.8 GB over a LAN that dies at 80% must resume, not restart.
    const files = P.collectModPayloadFiles(CLIENT, SERVER, mod("fika-server", "server"));
    const staging = path.join(STORE, "mods", ".staging", "server_fika-server@2.3.5");
    fs.mkdirSync(path.join(staging, "user", "mods", "fika-server"), { recursive: true });
    // One file already copied by the run that died, at the right size.
    fs.copyFileSync(
      path.join(SERVER, "user", "mods", "fika-server", "package.json"),
      path.join(staging, "user", "mods", "fika-server", "package.json")
    );
    const alreadyThere = fs.statSync(path.join(SERVER, "user", "mods", "fika-server", "package.json")).size;

    const r = await P.storePayload(STORE, files, { name: "fika-server", version: "2.3.5", type: "server" });
    check("completed", r.success, true);
    const total = files.reduce((s, f) => s + f.size, 0);
    check("skipped the file already staged", r.bytesCopied, total - alreadyThere);
    check("result is still complete", (await P.verifyPayload(STORE, r.key, true)).ok, true);
  }

  console.log("\napplying a payload into a SPLIT install");
  {
    const TARGET_CLIENT = path.join(root, "target");
    const TARGET_SERVER = path.join(root, "target", "SPT_Runtime");
    fs.mkdirSync(TARGET_CLIENT, { recursive: true });

    const r1 = await P.applyPayload(STORE, sainKey, TARGET_CLIENT, TARGET_SERVER, { enabled: true });
    check("client mod applied", r1.success, true);
    check("plugin landed", fs.existsSync(path.join(TARGET_CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll")), true);
    check("data folder landed", fs.existsSync(path.join(TARGET_CLIENT, "BepInEx", "plugins", "SAIN", "data", "presets.json")), true);
    check("prepatcher landed", fs.existsSync(path.join(TARGET_CLIENT, "BepInEx", "patchers", "SAIN.Prepatch.dll")), true);
    check("config landed", fs.existsSync(path.join(TARGET_CLIENT, "BepInEx", "config", "me.sol.sain.cfg")), true);

    const r2 = await P.applyPayload(STORE, "server_fika-server@2.3.5", TARGET_CLIENT, TARGET_SERVER, { enabled: true });
    check("server mod applied", r2.success, true);
    // The whole reason this is not a plain directory copy. Copying the payload wholesale to
    // the client root would put the server half where nothing ever reads it — a failure that
    // looks exactly like success.
    check(
      "server half went to the SERVER root",
      fs.existsSync(path.join(TARGET_SERVER, "user", "mods", "fika-server", "package.json")),
      true
    );
    check(
      "and NOT to the client root",
      fs.existsSync(path.join(TARGET_CLIENT, "user", "mods", "fika-server", "package.json")),
      false
    );
  }

  console.log("\napplying something the preset wants disabled");
  {
    const T = path.join(root, "target-disabled");
    fs.mkdirSync(T, { recursive: true });
    const r = await P.applyPayload(STORE, sainKey, T, T, { enabled: false });
    check("applied", r.success, true);
    check("into plugins.disabled", fs.existsSync(path.join(T, "BepInEx", "plugins.disabled", "SAIN", "SAIN.dll")), true);
    check("patcher into patchers.disabled", fs.existsSync(path.join(T, "BepInEx", "patchers.disabled", "SAIN.Prepatch.dll")), true);
    // Config is never "disabled": BepInEx reads it only when the plugin loads, and leaving it
    // in place is what makes re-enabling a mod restore its settings.
    check("config stays in BepInEx/config", fs.existsSync(path.join(T, "BepInEx", "config", "me.sol.sain.cfg")), true);
  }

  console.log("\na wounded payload is never applied");
  {
    const T = path.join(root, "target-wounded");
    fs.mkdirSync(T, { recursive: true });
    const r = await P.applyPayload(STORE, "Wounded@1.0.0", T, T, {});
    check("refused", r.success, false);
    check("says why", /Not applied/.test(r.message), true);
    check("nothing was written", fs.existsSync(path.join(T, "BepInEx")), false);
  }

  console.log("\nunrecognised paths are not guessed at");
  {
    // Writing an unrecognised path into a game install is not a small mistake.
    check("a stray top-level file", P.resolvePayloadTarget("something.txt", "C:/c", "C:/s", true), null);
    check("an unknown BepInEx folder", P.resolvePayloadTarget("BepInEx/cache/x.dat", "C:/c", "C:/s", true), null);
    check(
      "user/mods maps to the server root",
      P.resolvePayloadTarget("user/mods/x/a.js", "C:/c", "C:/s", true),
      path.join("C:/s", "user", "mods", "x", "a.js")
    );
  }

  console.log("\npublishing a preset WITH its files");
  {
    const mods = [
      mod("SAIN", "client", true, { guid: "me.sol.sain", version: "4.4.3", sourceUrl: "https://github.com/x/sain" }),
      mod("fika-server", "server", true, { version: "2.3.5" }),
      mod("Waypoints", "client", false, { version: "1.6.4" })
    ];
    const preset = createPreset(LOCAL, mods, { name: "Carried", sptVersion: "4.0.13" });
    check("captured", preset.mods.length, 3);

    const seen = [];
    const r = await S.publishPresetWithPayloads(
      STORE,
      preset,
      "cspicer5",
      { clientRoot: CLIENT, serverRoot: SERVER },
      mods,
      (p) => seen.push(p)
    );
    check("published", r.success, true);
    check("declares that it carries files", r.preset.hasPayloads, true);
    check("every mod carried", r.preset.mods.filter((m) => m.payload).length, 3);
    check("each records a hash", r.preset.mods.every((m) => !!m.payloadHash), true);
    check("and a size", r.preset.mods.every((m) => typeof m.sizeBytes === "number"), true);
    // SAIN's payload was stored earlier by a call that knew no sourceUrl, so this publish
    // REUSES it. Reading the metadata off the reused manifest silently dropped the URL this
    // machine knew — and that is the one field that still matters once Forge is gone, since
    // it is how you find a mod the preset does not carry.
    check("sourceUrl survives a reused payload", r.preset.mods.find((m) => m.name === "SAIN").sourceUrl, "https://github.com/x/sain");
    // SAIN and fika-server are already in the store from earlier, so only Waypoints is new.
    check("reused what was already stored", r.reused, 2);
    check("progress was reported", seen.length > 0, true);
    check("progress names the mod", typeof seen[0].mod, "string");
  }

  console.log("\ninstalling a carried preset onto a bare machine");
  {
    const T = path.join(root, "fresh");
    const TS = path.join(root, "fresh", "SPT_Runtime");
    fs.mkdirSync(T, { recursive: true });

    const preset = await S.readStorePreset(STORE, "carried");
    check("found in the store", preset?.mods.length, 3);

    const r = await S.applyPresetPayloads(STORE, preset, { clientRoot: T, serverRoot: TS }, null);
    check("installed everything", r.success, true);
    check("three mods", r.installed.length, 3);
    check("nothing skipped", r.skipped.length, 0);
    // The point of the whole phase: a friend with none of these mods and no Forge ends up
    // with a working install.
    check("client mod present", fs.existsSync(path.join(T, "BepInEx", "plugins", "SAIN", "SAIN.dll")), true);
    check("server mod present", fs.existsSync(path.join(TS, "user", "mods", "fika-server", "package.json")), true);
    check("the disabled one arrived disabled", fs.existsSync(path.join(T, "BepInEx", "plugins.disabled", "Waypoints", "Waypoints.dll")), true);
    check("and NOT enabled", fs.existsSync(path.join(T, "BepInEx", "plugins", "Waypoints")), false);
  }

  console.log("\ninstalling from a payload records what it installed");
  {
    // Found by installing 5 mods onto the real install and watching the ledger degrade: a
    // payload install rewrites every file, so mtimes change even when the bytes are
    // identical, and the fingerprint is deliberately stat-only. Without recording here, the
    // 5 mods flipped from "recorded" to "stale-record" and went back to trusting whatever
    // they declare about themselves — which is the exact thing the ledger exists to stop.
    const T = path.join(root, "ledger-target");
    const TS = path.join(T, "SPT_Runtime");
    fs.mkdirSync(T, { recursive: true });

    const preset = await S.readStorePreset(STORE, "carried");
    await S.applyPresetPayloads(STORE, preset, { clientRoot: T, serverRoot: TS }, null);

    const registry = JSON.parse(fs.readFileSync(path.join(T, ".spt-mod-manager-registry.json"), "utf-8"));
    check("every installed mod was recorded", registry.length, 3);

    const sain = registry.find((e) => e.id === "SAIN");
    check("with the version the preset carried", sain?.installedVersion, "4.4.3");
    check("marked as coming from a preset", sain?.versionOrigin, "preset");
    check("evidence names the preset", /Carried/.test(sain?.versionEvidence ?? ""), true);
    // The payload's content hash is the strongest evidence any install path has.
    check("and cites the payload hash", /payload [0-9a-f]{12}/.test(sain?.versionEvidence ?? ""), true);
    check("fingerprinted so the record can go stale later", typeof sain?.fingerprint?.files, "number");

    // The fingerprint must describe the files as they now are, or the record is born stale.
    const scanned = require(path.join(dist, "modManager.js")).scanMods(T, TS);
    const sainScanned = scanned.find((m) => m.id === "SAIN" && m.type === "client");
    check("so a scan reports it as recorded, not stale", sainScanned?.versionSource, "recorded");
    check("at the preset's version", sainScanned?.version, "4.4.3");

    const server = registry.find((e) => e.id === "fika-server");
    check("the server half recorded too", server?.versionOrigin, "preset");
    // Split install: the ledger lives on the CLIENT root, but the mod is under the server one.
    check("and fingerprinted from the server root", server?.fingerprint?.files > 0, true);
  }

  console.log("\na preset that names a mod it does not carry");
  {
    const preset = {
      schema: 1,
      id: "partial",
      name: "Partial",
      createdAt: "",
      updatedAt: "",
      hasPayloads: true,
      mods: [{ name: "Ghost", type: "client", enabled: true, loadOrder: 1, required: true, sourceUrl: "https://github.com/x/ghost" }]
    };
    const T = path.join(root, "partial-target");
    fs.mkdirSync(T, { recursive: true });
    const r = await S.applyPresetPayloads(STORE, preset, { clientRoot: T, serverRoot: T }, null);
    check("does not claim to have installed it", r.installed.length, 0);
    check("reported as skipped, not failed", r.skipped.length, 1);
    // "Missing" and "we have it but can't install it" send the user to entirely different
    // places, so they are never conflated.
    check("and points at where to get it", /github.com\/x\/ghost/.test(r.skipped[0].message), true);
  }

  console.log("\nhousekeeping");
  {
    const usage = await P.storeUsage(STORE);
    check("counts the payloads", usage.payloads >= 4, true);
    check("and their bytes", usage.bytes > 0, true);

    const inUse = await S.payloadKeysInUse(STORE);
    check("knows which keys presets still need", inUse.has("client_SAIN@4.4.3"), true);

    // The orphans here are the second SAIN build and the deliberately wounded payload,
    // neither of which any preset refers to.
    const gc = await P.collectOrphanPayloads(STORE, inUse);
    check("removed what nothing refers to", gc.removed.length >= 2, true);
    check("kept what is in use", fs.existsSync(path.join(STORE, "mods", "client_SAIN@4.4.3")), true);
    check("the wounded payload is gone", fs.existsSync(path.join(STORE, "mods", "Wounded@1.0.0")), false);
  }

  console.log("\nformatting");
  {
    check("bytes", P.formatBytes(512), "512 B");
    check("kilobytes", P.formatBytes(2048), "2.0 KB");
    check("gigabytes", P.formatBytes(4.76 * 1024 ** 3), "4.8 GB");
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err?.stack ?? err);
  process.exit(1);
});
