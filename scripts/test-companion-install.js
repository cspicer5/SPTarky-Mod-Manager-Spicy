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

// Either build serves for the install mechanics below — what is copied is bytes. Which build an
// instance NEEDS is a separate decision, tested on its own further down.
const dll = path.join(__dirname, "..", "companion", "dist", "spt4.0", "SptarkyCompanion.dll");

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

console.log("which build an SPT version needs");
{
  // The pairing that matters: 4.1 moved the server to .NET 10, so these are not interchangeable.
  check("4.0.13 takes the 4.0 build", C.companionLineFor("4.0.13"), "spt4.0");
  check("4.1.5 takes the 4.1 build", C.companionLineFor("4.1.5"), "spt4.1");
  check("4.1.0 is already the new line", C.companionLineFor("4.1.0"), "spt4.1");

  // SPT reports 4.0.13-RELEASE+2891fd4.… in some places. The suffix must not defeat the match.
  check("a RELEASE suffix still resolves", C.companionLineFor("4.0.13-RELEASE+2891fd4.20260302"), "spt4.0");
  check("surrounding space is tolerated", C.companionLineFor(" 4.1.5 "), "spt4.1");

  // An assumption, stated: a minor we have never seen gets the newest build there is.
  check("a future 4.x gets the newest build", C.companionLineFor("4.2.0"), "spt4.1");

  // Refusals. Each of these would otherwise put an unloadable DLL into user/mods, and that
  // failure is invisible from the manager — the file is there and nothing ever answers.
  check("3.x has no .NET server mods at all", C.companionLineFor("3.9.8"), undefined);
  check("an unknown version refuses", C.companionLineFor(undefined), undefined);
  check("so does an empty string", C.companionLineFor(""), undefined);
  check("so does something that is not a version", C.companionLineFor("latest"), undefined);
}

console.log("\nan instance whose version could not be worked out");
{
  check("cannot be installed into", C.readInstallState(root, undefined).canInstall, false);
  check("and is told it is a version problem", /SPT version/.test(C.readInstallState(root, undefined).reason), true);
  check("installing refuses too", C.installCompanion(root, undefined).ok, false);
}

console.log("\ninstances that cannot take it");
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

console.log("\nthe companion's three version strings agree");
{
  /*
   * There are THREE, in two languages, and they HAD drifted:
   *
   *   ModMetadata.cs      1.0.0  - what SPT prints in its own log when the mod loads
   *   SptarkyRouter.cs    1.1.0  - what /sptarky/version answers a manager that asks
   *   companionInstall.ts 1.0.0  - what the app shows beside the Install button
   *
   * So the manager told you it ships 1.0.0 while the companion already installed reported
   * 1.1.0 — the app claiming to be older than the thing it installed. Every one of them is
   * shown to a person, and none of them can share a constant across C# and TypeScript.
   *
   * Pinned here instead. This is a source-text check on purpose: the failure is three editors
   * disagreeing, which no amount of runtime behaviour can reveal.
   */
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf-8");
  const meta = /DeclaredVersion => new\((\d+), (\d+), (\d+)\)/.exec(read("companion/src/ModMetadata.cs"));
  const router = /CompanionVersion = "([^"]+)"/.exec(read("companion/src/SptarkyRouter.cs"));
  const bundled = /BUNDLED_COMPANION_VERSION = "([^"]+)"/.exec(read("electron/companionInstall.ts"));

  check("the mod metadata names a version", !!meta, true);
  check("the router names one", !!router, true);
  check("the manager names one", !!bundled, true);

  const metaVersion = meta ? `${meta[1]}.${meta[2]}.${meta[3]}` : "?";
  check("what SPT logs matches what the route reports", metaVersion, router ? router[1] : "?");
  check("and matches what the manager says it ships", metaVersion, bundled ? bundled[1] : "?");
  // The COMPILED constant too, so a stale dist-electron cannot pass this by accident.
  check("and matches the built constant the app actually uses", C.BUNDLED_COMPANION_VERSION, metaVersion);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
