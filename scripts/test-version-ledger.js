/**
 * The Fika-server scenario, end to end.
 *
 * You download Fika Server 2.3.5. The mod's own package.json says 2.0.9, because its author
 * does not maintain that field. The app must report 2.3.5 — what it actually installed — and
 * must stop reporting it the moment someone changes the files by hand.
 *
 * Everything happens in a temp directory; no real install is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require(path.join(__dirname, "..", "node_modules", "adm-zip"));

const dist = path.join(__dirname, "..", "dist-electron");
const { installModFromArchive, scanMods } = require(path.join(dist, "modManager.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-ledger-"));
const INSTALL = path.join(root, "spt");
fs.mkdirSync(path.join(INSTALL, "user", "mods"), { recursive: true });
fs.mkdirSync(path.join(INSTALL, "BepInEx", "plugins"), { recursive: true });

/** An archive named for its real version, containing a mod that under-declares itself. */
function makeArchive(fileName, modFolder, declaredVersion) {
  const zip = new AdmZip();
  zip.addFile(
    `${modFolder}/package.json`,
    Buffer.from(JSON.stringify({ name: modFolder, version: declaredVersion, author: "Fika" }, null, 2))
  );
  zip.addFile(`${modFolder}/src/mod.js`, Buffer.from("// mod code\n"));
  const archivePath = path.join(root, fileName);
  zip.writeZip(archivePath);
  return archivePath;
}

// installModFromArchive is async (extraction is), so the whole run lives in main().
async function main() {
const archive = makeArchive("Fika.Server.Release.2.3.5.zip", "fika-server", "2.0.9");

console.log("installing an archive named 2.3.5 whose package.json claims 2.0.9");
const install = await installModFromArchive(INSTALL, INSTALL, archive);
check("install succeeded", install.success, true);
if (!install.success) console.log("          message:", install.message);

const find = () => scanMods(INSTALL, INSTALL).find((m) => m.id === "fika-server");

let mod = find();
check("reports the version that was installed", mod?.version, "2.3.5");
check("marked as recorded", mod?.versionSource, "recorded");
check("origin is the archive name", mod?.versionOrigin, "archive-name");
check("evidence names the archive", mod?.versionEvidence, "Fika.Server.Release.2.3.5.zip");
check("surfaces the disagreement", mod?.declaredVersion, "2.0.9");

console.log("\nregistry keeps the record");
const registry = JSON.parse(fs.readFileSync(path.join(INSTALL, ".spt-mod-manager-registry.json"), "utf-8"));
const entry = registry.find((e) => e.id === "fika-server");
check("installedVersion stored", entry?.installedVersion, "2.3.5");
check("fingerprint stored", typeof entry?.fingerprint?.files, "number");

console.log("\nsomeone replaces the files by hand — the record no longer describes what is there");
const installedFile = path.join(INSTALL, "user", "mods", "fika-server", "src", "mod.js");
fs.writeFileSync(installedFile, "// a different build entirely, with more content\n");

mod = find();
// The recorded version described files that no longer exist, so stating it would be a
// confident lie. The mod's own claim is the better guess again, and is labelled as such.
check("falls back to the declared version", mod?.version, "2.0.9");
check("flagged as a stale record", mod?.versionSource, "stale-record");
check("no longer claims an origin", mod?.versionOrigin, undefined);

console.log("\na mod whose archive carries no version");
const plain = makeArchive("SomeClientMod.zip", "SomeClientMod", "1.2.3");
await installModFromArchive(INSTALL, INSTALL, plain);
const other = scanMods(INSTALL, INSTALL).find((m) => m.id === "SomeClientMod");
// Nothing better than the mod's own word was available, but it is pinned to install time
// rather than being re-read for ever.
check("falls back to what it declared at install", other?.version, "1.2.3");
check("origin recorded as declared-at-install", other?.versionOrigin, "declared-at-install");

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
