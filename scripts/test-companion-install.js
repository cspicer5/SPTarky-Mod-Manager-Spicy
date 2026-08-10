/**
 * Installing the server companion into a local instance.
 *
 * Two properties matter more than the happy path.
 *
 * First, this WRITES to somebody's SPT install, so removal is scoped to the two files the app
 * put there rather than deleting the folder. A recursive delete of a path assembled from
 * settings is the operation worth not writing, and the folder is a plausible place for someone
 * to have left something of their own.
 *
 * Second, an upgrade must not destroy an edited config.json — it holds the token, and silently
 * resetting it would take a server offline for everyone who could previously reach it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require(path.join(__dirname, "..", "dist-electron", "companionInstall.js"));

const dll = path.join(__dirname, "..", "companion", "dist", "SptarkyCompanion.dll");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== companion install ===\n");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-inst-"));
const target = path.join(root, "user", "mods", "SptarkyCompanion", "SptarkyCompanion.dll");
const cfg = path.join(root, "user", "mods", "SptarkyCompanion", "config.json");

console.log("instances that cannot take it");
{
  check("a client-only folder refuses", C.readInstallState(root, dll).canInstall, false);
  check("and says why", /not a server install/.test(C.readInstallState(root, dll).reason), true);
  check("no instance selected refuses", C.readInstallState(undefined, dll).canInstall, false);
}

console.log("\ninstalling");
{
  fs.mkdirSync(path.join(root, "user", "mods"), { recursive: true });
  check("a server install can take it", C.readInstallState(root, dll).canInstall, true);
  check("and is not yet installed", C.readInstallState(root, dll).installed, false);

  const r = C.installCompanion(root, dll);
  check("succeeds", r.ok, true);
  // A mod on disk but not loaded looks identical to one that failed, and people conclude the
  // install did not work. So the next step is stated.
  check("and says to restart the server", /Restart the SPT server/.test(r.message), true);
  check("the dll landed", fs.existsSync(target), true);
  check("byte-identical to the bundled one", fs.readFileSync(target).equals(fs.readFileSync(dll)), true);
  check("now reads as installed", C.readInstallState(root, dll).installed, true);
  check("and matches the bundled build", C.readInstallState(root, dll).differsFromBundled, false);
}

console.log("\nupgrading over an older build");
{
  fs.writeFileSync(target, Buffer.alloc(999));
  check("a different build is noticed", C.readInstallState(root, dll).differsFromBundled, true);
  const r = C.installCompanion(root, dll);
  check("reinstall overwrites it", r.ok, true);
  check("and the wording says updated, not installed", /updated/i.test(r.message), true);
  check("it matches again afterwards", C.readInstallState(root, dll).differsFromBundled, false);
}

console.log("\nthe owner's config survives");
{
  fs.writeFileSync(cfg, JSON.stringify({ requireToken: true, token: "keep-me" }));
  C.installCompanion(root, dll);
  // Resetting this on upgrade would lock out every manager that could previously reach it.
  check("an edited config is not touched by an upgrade", JSON.parse(fs.readFileSync(cfg, "utf-8")).token, "keep-me");
  check("and the token flag is reported back", C.readInstallState(root, dll).requiresToken, true);
}

console.log("\nremoval is scoped, not a recursive delete");
{
  const mine = path.join(path.dirname(target), "notes.txt");
  fs.writeFileSync(mine, "mine");
  const r = C.removeCompanion(root);
  check("succeeds", r.ok, true);
  check("the dll is gone", fs.existsSync(target), false);
  check("a file that was never ours is left alone", fs.existsSync(mine), true);

  fs.unlinkSync(mine);
  C.removeCompanion(root);
  check("an emptied folder is tidied up", fs.existsSync(path.dirname(target)), false);
  check("removing what is not there is not an error", C.removeCompanion(root).ok, true);
  check("nor is removing with no instance", C.removeCompanion(undefined).ok, false);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
