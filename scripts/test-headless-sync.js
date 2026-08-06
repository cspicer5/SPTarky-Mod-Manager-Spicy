/**
 * Exercises copyClientModToHeadless against a purpose-built pair of installs.
 *
 * A real install does not necessarily contain every shape a plugin can take — D:\SPT has no
 * loose-DLL-with-companion-folder mod, for instance — so those branches would otherwise ship
 * having never run. Everything here is created under a temp directory and removed after.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const { copyClientModToHeadless, removeModFromHeadless } = require(path.join(dist, "modManager.js"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-sync-"));
const MAIN = path.join(root, "main");
const HEADLESS = path.join(root, "headless");

const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

// --- main install -----------------------------------------------------------
write(path.join(MAIN, "BepInEx", "plugins", "FolderMod", "FolderMod.dll"), "binary");
write(path.join(MAIN, "BepInEx", "plugins", "FolderMod", "Presets", "preset.json"), "{}"); // SAIN-style nested config
write(path.join(MAIN, "BepInEx", "plugins", "LooseMod.dll"), "binary");
write(path.join(MAIN, "BepInEx", "plugins", "LooseMod", "assets.bundle"), "data"); // companion folder
write(path.join(MAIN, "BepInEx", "patchers", "LooseMod.Prepatch.dll"), "patcher");
write(path.join(MAIN, "BepInEx", "patchers", "UnrelatedModExtras.dll"), "other"); // must NOT travel
write(path.join(MAIN, "BepInEx", "config", "com.test.loose.cfg"), "[General]");
write(path.join(MAIN, "BepInEx", "config", "com.other.mod.cfg"), "[Other]"); // must NOT travel
write(path.join(MAIN, "user", "mods", "ServerOnlyMod", "package.json"), "{}");
write(path.join(MAIN, "BepInEx", "plugins.disabled", "DisabledMod", "DisabledMod.dll"), "binary");

// --- headless install: has an OLD copy of FolderMod, to prove overwrite ------
write(path.join(HEADLESS, "FikaHeadlessManager.exe"), "stub");
write(path.join(HEADLESS, "BepInEx", "plugins", "FolderMod", "FolderMod.dll"), "OLD VERSION");
write(path.join(HEADLESS, "BepInEx", "plugins", "FolderMod", "stale-leftover.txt"), "should not survive");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${expected}, got ${actual}`}`);
};
const exists = (...parts) => fs.existsSync(path.join(HEADLESS, ...parts));
const read = (...parts) => (exists(...parts) ? fs.readFileSync(path.join(HEADLESS, ...parts), "utf-8") : null);

const mod = (id, type, enabled, guid) => ({ id, name: id, originalName: id, type, enabled, guid });

console.log("folder plugin, overwriting an older copy");
let r = copyClientModToHeadless(MAIN, HEADLESS, mod("FolderMod", "client", true));
check("reported success", r.success, true);
check("plugin copied", exists("BepInEx", "plugins", "FolderMod", "FolderMod.dll"), true);
check("overwrote the old file", read("BepInEx", "plugins", "FolderMod", "FolderMod.dll"), "binary");
// Replacing rather than merging matters: a file from an older version left underneath is a
// genuine source of "I updated it and it still misbehaves".
check("stale leftover removed", exists("BepInEx", "plugins", "FolderMod", "stale-leftover.txt"), false);
check("nested config folder came too (SAIN/Donuts shape)", exists("BepInEx", "plugins", "FolderMod", "Presets", "preset.json"), true);

console.log("\nloose .dll with companion folder, patcher and config");
r = copyClientModToHeadless(MAIN, HEADLESS, mod("LooseMod.dll", "client", true, "com.test.loose"));
check("reported success", r.success, true);
check("the dll itself", exists("BepInEx", "plugins", "LooseMod.dll"), true);
check("companion data folder", exists("BepInEx", "plugins", "LooseMod", "assets.bundle"), true);
check("prepatcher", exists("BepInEx", "patchers", "LooseMod.Prepatch.dll"), true);
check("config matched by GUID", exists("BepInEx", "config", "com.test.loose.cfg"), true);
check("another mod's patcher left alone", exists("BepInEx", "patchers", "UnrelatedModExtras.dll"), false);
check("another mod's config left alone", exists("BepInEx", "config", "com.other.mod.cfg"), false);

console.log("\ndisabled plugin stays disabled on the other side");
r = copyClientModToHeadless(MAIN, HEADLESS, mod("DisabledMod", "client", false));
check("reported success", r.success, true);
check("landed in plugins.disabled", exists("BepInEx", "plugins.disabled", "DisabledMod", "DisabledMod.dll"), true);
check("did NOT land in plugins", exists("BepInEx", "plugins", "DisabledMod"), false);

console.log("\nrefusals");
r = copyClientModToHeadless(MAIN, HEADLESS, mod("ServerOnlyMod", "server", true));
check("server mod refused", r.success, false);
check("nothing written to headless user/mods", exists("user", "mods", "ServerOnlyMod"), false);

r = copyClientModToHeadless(MAIN, MAIN, mod("FolderMod", "client", true));
check("refuses when both paths are the same install", r.success, false);

r = copyClientModToHeadless(MAIN, HEADLESS, mod("spt", "client", true));
check("refuses to copy SPT's own core", r.success, false);

r = copyClientModToHeadless(MAIN, HEADLESS, mod("NotInstalled", "client", true));
check("missing source reported, not thrown", r.success, false);

console.log("\nremoval affects the headless side only");
r = removeModFromHeadless(HEADLESS, mod("FolderMod", "client", true));
check("removed from headless", exists("BepInEx", "plugins", "FolderMod"), false);
check("main install untouched", fs.existsSync(path.join(MAIN, "BepInEx", "plugins", "FolderMod", "FolderMod.dll")), true);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
