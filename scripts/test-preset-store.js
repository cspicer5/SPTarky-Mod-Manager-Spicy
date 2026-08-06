/**
 * The shared preset store — phase 2.
 *
 * The store is a folder two or more people write to at once, which is where the interesting
 * failures live: a curated store that lets a stranger publish, a sync tool that duplicates a
 * file, an accidental id collision between two people who both called their setup "Co-op".
 * Each of those silently produces a WRONG preset rather than an error, so each has a test.
 *
 * Everything happens in a temp directory; no real store or install is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const S = require(path.join(dist, "presetStore.js"));
const { createPreset, readPreset, listPresets } = require(path.join(dist, "presets.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-store-"));
const STORE = path.join(root, "share", "SPT-Presets");
const LOCAL_A = path.join(root, "client-a");
const LOCAL_B = path.join(root, "client-b");
fs.mkdirSync(STORE, { recursive: true });
fs.mkdirSync(LOCAL_A, { recursive: true });
fs.mkdirSync(LOCAL_B, { recursive: true });

/** Just enough of a ModInfo for createPreset to capture. */
const mod = (id, type, version, enabled = true) => ({
  id,
  originalName: id,
  name: id,
  guid: `com.test.${id.toLowerCase()}`,
  version,
  versionSource: "recorded",
  type,
  enabled,
  loadOrder: 1,
  author: "tester"
});

const MODS = [
  mod("SAIN", "client", "4.4.3"),
  mod("fika-server", "server", "2.3.5"),
  mod("Waypoints", "client", "1.6.4", false)
];

async function main() {
  console.log("a plain folder is not a store");
  check("readStoreInfo returns null", await S.readStoreInfo(STORE), null);
  {
    const status = await S.getStoreStatus(STORE, "cspicer5");
    check("not connected", status.connected, false);
    check("cannot publish", status.canPublish, false);
    check("says why", /isn't a preset store/.test(status.message ?? ""), true);
  }
  {
    // An unreachable share is a different answer from "not a store", and the message has to
    // point at the network rather than at the folder's contents.
    const status = await S.getStoreStatus(path.join(root, "no-such-share"), "cspicer5");
    check("missing folder is not connected", status.connected, false);
    check("blames the connection, not the format", /can't be reached/.test(status.message ?? ""), true);
  }

  console.log("\ncreating a store");
  {
    const r = await S.initStore(STORE, { name: "Spicy Co-op", owner: "cspicer5", writePolicy: "shared" });
    check("created", r.success, true);
    check("store.json exists", fs.existsSync(path.join(STORE, "store.json")), true);
    check("presets/ exists", fs.existsSync(path.join(STORE, "presets")), true);
    check("owner recorded", r.info?.owner, "cspicer5");

    // Pointing "create" at a folder that already holds everyone's presets would hand the
    // whole store to whoever clicked it.
    const again = await S.initStore(STORE, { name: "Hijack", owner: "someone-else" });
    check("refuses to overwrite an existing store", again.success, false);
    check("names the existing store", /Spicy Co-op/.test(again.message), true);
    check("owner unchanged", (await S.readStoreInfo(STORE)).owner, "cspicer5");
  }

  console.log("\nwrite policy");
  {
    const shared = { schema: 1, name: "s", writePolicy: "shared", owner: "cspicer5", createdAt: "" };
    const curated = { schema: 1, name: "s", writePolicy: "curated", owner: "cspicer5", createdAt: "" };
    check("shared: a stranger may publish", S.publishPermission(shared, "friend").allowed, true);
    check("curated: the owner may", S.publishPermission(curated, "cspicer5").allowed, true);
    check("curated: identity is case-insensitive", S.publishPermission(curated, "CSpicer5").allowed, true);
    check("curated: a stranger may not", S.publishPermission(curated, "friend").allowed, false);
    check("curated: says who does publish", /only cspicer5/i.test(S.publishPermission(curated, "friend").reason), true);
    // Publishing anonymously would put a preset in front of other people with no way to ask
    // the author anything about it.
    check("no identity: blocked even when shared", S.publishPermission(shared, "  ").allowed, false);
  }
  {
    // A store written by a future version might use a policy this build has never heard of.
    // Guessing "shared" would let this client publish into a store that meant to forbid it.
    fs.writeFileSync(
      path.join(STORE, "store.json"),
      JSON.stringify({ schema: 1, name: "Spicy Co-op", writePolicy: "invite-only", owner: "cspicer5", createdAt: "" })
    );
    const info = await S.readStoreInfo(STORE);
    check("an unknown policy reads as the stricter one", info.writePolicy, "curated");
    check("...so a stranger is refused", S.publishPermission(info, "friend").allowed, false);
    fs.writeFileSync(
      path.join(STORE, "store.json"),
      JSON.stringify({ schema: 1, name: "Spicy Co-op", writePolicy: "shared", owner: "cspicer5", createdAt: "" })
    );
  }

  console.log("\npublishing");
  const localPreset = createPreset(LOCAL_A, MODS, { name: "Stable Co-op", author: "cspicer5", sptVersion: "4.0.13" });
  // Derived, not assumed: slugify("Stable Co-op") keeps the hyphen already in "Co-op".
  const ID = localPreset.id;
  check("captured locally", localPreset.mods.length, 3);
  {
    const r = await S.publishPreset(STORE, localPreset, "cspicer5");
    check("published", r.success, true);
    check("file named for the id", fs.existsSync(path.join(STORE, "presets", `${ID}.json`)), true);
    check("author stamped", r.preset.author, "cspicer5");
    // Phase 2 shares manifests only. Carrying a payload flag across would promise files the
    // store does not have, and apply would fail at the moment it mattered.
    check("never claims payloads it did not copy", r.preset.hasPayloads, false);
    check("enabled state survives the round trip", r.preset.mods.find((m) => m.name === "Waypoints").enabled, false);

    const listed = await S.listStorePresets(STORE);
    check("appears in the store", listed.length, 1);
    check("with its mods", listed[0].preset.mods.length, 3);
  }

  console.log("\nid collision between two people");
  {
    // Ids come from the preset's NAME, so two people who both call a setup "Stable Co-op"
    // collide by accident, not by intent.
    const friendPreset = createPreset(LOCAL_B, [mod("SAIN", "client", "4.4.3")], { name: "Stable Co-op" });
    check("same id derived", friendPreset.id, ID);

    const blocked = await S.publishPreset(STORE, friendPreset, "friend");
    check("does not silently replace", blocked.success, false);
    check("asks first", blocked.needsConfirmation, true);
    check("names the other author", /cspicer5/.test(blocked.message), true);

    const stillTheirs = await S.listStorePresets(STORE);
    check("the store is untouched", stillTheirs[0].preset.mods.length, 3);
    check("still the original author", stillTheirs[0].preset.author, "cspicer5");

    const forced = await S.publishPreset(STORE, friendPreset, "friend", { overwrite: true });
    check("goes ahead when confirmed", forced.success, true);
    const after = await S.listStorePresets(STORE);
    check("now the friend's", after[0].preset.author, "friend");
    check("and their contents", after[0].preset.mods.length, 1);

    await S.publishPreset(STORE, localPreset, "cspicer5", { overwrite: true }); // restore
  }

  console.log("\na sync tool duplicated a file");
  {
    // Syncthing and Dropbox resolve a concurrent edit by KEEPING BOTH files. Both parse, and
    // both claim the same id — so a naive reader shows the preset twice, or worse, picks one
    // at random and calls it the truth.
    const original = path.join(STORE, "presets", `${ID}.json`);
    const conflicted = path.join(STORE, "presets", `${ID}.sync-conflict-20260806-113000.json`);
    const older = JSON.parse(fs.readFileSync(original, "utf-8"));
    fs.writeFileSync(
      conflicted,
      JSON.stringify({ ...older, updatedAt: "2000-01-01T00:00:00.000Z", mods: [], author: "stale" })
    );

    const listed = await S.listStorePresets(STORE);
    check("still one preset, not two", listed.length, 1);
    check("the newest copy wins", listed[0].preset.mods.length, 3);
    check("the collision is reported, not hidden", listed[0].conflictsWith?.length, 1);
    check("and named", /sync-conflict/.test(listed[0].conflictsWith[0]), true);
  }

  console.log("\na half-written file is invisible");
  {
    // Publishing writes to a temp name and renames. A reader arriving mid-publish must not
    // see a partial manifest and treat its truncated mod list as the real one.
    fs.writeFileSync(path.join(STORE, "presets", "half-written.json.1234.tmp"), '{"schema":1,"id":"half"');
    const listed = await S.listStorePresets(STORE);
    check("temp files are skipped", listed.length, 1);
  }

  console.log("\nimporting from the store");
  {
    // The friend still has their OWN "Stable Co-op" locally, from the collision above — the
    // realistic case, since the id came from a name both of them chose independently.
    // Importing must not quietly overwrite their own work.
    const first = await S.importPreset(LOCAL_B, STORE, ID);
    check("will not silently replace their own preset of the same name", first.success, false);
    check("asks first", first.needsConfirmation, true);
    check("their copy is untouched", readPreset(LOCAL_B, ID).mods.length, 1);

    const r = await S.importPreset(LOCAL_B, STORE, ID, { overwrite: true });
    check("imported when confirmed", r.success, true);
    // Applying a preset copies somebody else's idea of a correct setup onto your machine.
    // Where it came from stays visible afterwards, not only at the moment you clicked.
    check("records the store it came from", r.preset.origin?.store, "Spicy Co-op");
    check("records the author", r.preset.origin?.author, "cspicer5");
    check("mods came across", readPreset(LOCAL_B, ID).mods.length, 3);

    const missing = await S.importPreset(LOCAL_B, STORE, "no-such-preset");
    check("importing something absent fails cleanly", missing.success, false);
  }

  console.log("\nexport and import as a loose file (no store involved)");
  {
    const mine = readPreset(LOCAL_A, ID);
    const file = path.join(root, S.presetFileName(mine));
    check("filename is recognisable", path.basename(file), `${ID}.sptpreset.json`);

    const exported = await S.exportPresetToFile(mine, file);
    check("exported", exported.success, true);
    check("file written", fs.existsSync(file), true);

    // The same format the store holds — so a file a friend sends can be dropped straight
    // into a store's presets/ folder, and there is no export-only variant to drift.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    check("readable as a preset", onDisk.schema, 1);
    check("mods came with it", onDisk.mods.length, 3);
    check("enabled state survived", onDisk.mods.find((m) => m.name === "Waypoints").enabled, false);

    // A local origin describes where THIS machine got it and means nothing to the person
    // receiving it — it would point at a store they cannot reach.
    const localCopy = readPreset(LOCAL_B, ID);
    check("the imported copy has an origin", !!localCopy.origin, true);
    const reExported = path.join(root, "passed-on.json");
    await S.exportPresetToFile(localCopy, reExported);
    check("but an export does not carry it", JSON.parse(fs.readFileSync(reExported, "utf-8")).origin, undefined);

    // A fresh machine: no store connected, just the file a friend sent.
    const LOCAL_C = path.join(root, "client-c");
    fs.mkdirSync(LOCAL_C, { recursive: true });
    const r = await S.importPresetFromFile(LOCAL_C, file);
    check("imported from the file", r.success, true);
    check("saved locally", readPreset(LOCAL_C, ID).mods.length, 3);
    check("origin says it came from a file", r.preset.origin?.store, "a file");
    check("and keeps the author", r.preset.origin?.author, "cspicer5");

    const again = await S.importPresetFromFile(LOCAL_C, file);
    check("will not silently replace", again.success, false);
    check("asks first", again.needsConfirmation, true);
    check(
      "goes ahead when confirmed",
      (await S.importPresetFromFile(LOCAL_C, file, { overwrite: true })).success,
      true
    );

    // This file arrived from outside the app, and what it becomes is a list of code to
    // install. Validated rather than trusted.
    const notAPreset = path.join(root, "holiday-photos.json");
    fs.writeFileSync(notAPreset, JSON.stringify({ hello: "world" }));
    const rejected = await S.importPresetFromFile(LOCAL_C, notAPreset);
    check("a non-preset is refused", rejected.success, false);
    check("and says so plainly", /isn't a mod preset/.test(rejected.message), true);

    const fromFuture = path.join(root, "from-the-future.json");
    fs.writeFileSync(fromFuture, JSON.stringify({ schema: 99, id: "x", mods: [] }));
    const future = await S.importPresetFromFile(LOCAL_C, fromFuture);
    check("a newer schema is refused", future.success, false);
    check("...telling the user to update rather than blaming the file", /Update/.test(future.message), true);

    const corrupt = path.join(root, "truncated.json");
    fs.writeFileSync(corrupt, '{"schema":1,"id":"x","mods":[');
    check("truncated JSON fails cleanly", (await S.importPresetFromFile(LOCAL_C, corrupt)).success, false);
    check(
      "a missing file fails cleanly",
      (await S.importPresetFromFile(LOCAL_C, path.join(root, "nope.json"))).success,
      false
    );
  }

  console.log("\nunpublishing");
  {
    const stranger = await S.unpublishPreset(STORE, ID, "someone-random");
    check("a stranger cannot remove it", stranger.success, false);

    const byAuthor = await S.unpublishPreset(STORE, ID, "cspicer5");
    check("its author can", byAuthor.success, true);
    check("gone from the store", (await S.listStorePresets(STORE)).length, 0);
    // The conflicted copy has to go too, or the preset reappears on the next read as the
    // surviving file — looking, to everyone else, as though the removal failed silently.
    check(
      "the conflicted copy went with it",
      fs.readdirSync(path.join(STORE, "presets")).filter((f) => f.includes("sync-conflict")).length,
      0
    );
  }

  console.log("\nchanging the policy");
  {
    const bad = await S.setWritePolicy(STORE, "friend", "curated");
    check("only the owner may change it", bad.success, false);
    const good = await S.setWritePolicy(STORE, "cspicer5", "curated");
    check("the owner may", good.success, true);
    check("persisted", (await S.readStoreInfo(STORE)).writePolicy, "curated");

    const status = await S.getStoreStatus(STORE, "friend");
    check("a stranger now sees publishing blocked", status.canPublish, false);
    check("with a reason", !!status.publishBlockedReason, true);
    check("but can still read the store", status.connected, true);
  }

  console.log("\nlocal presets are unaffected by any of this");
  check("client A still has its own", listPresets(LOCAL_A).length, 1);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err?.stack ?? err);
  process.exit(1);
});
