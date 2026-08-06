/**
 * The config backup/restore that makes a bulk reinstall survivable.
 *
 * A reinstall overwrites mod folders, and configuration lives in three different places —
 * one of them INSIDE the folder being replaced (SAIN presets, Donuts config). On the
 * reference install 27 .cfg files and a SAIN preset had been edited the same day, so losing
 * these would be worse than the problem the reinstall solves.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const { backupConfigs, restoreConfigs, collectConfigPaths, reinstallableMods } = require(
  path.join(dist, "bulkReinstall.js")
);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-bulk-"));
const CLIENT = path.join(root, "spt");
const SERVER = CLIENT; // the common, non-split case

const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};

// The three places configuration hides.
write(path.join(CLIENT, "BepInEx", "config", "me.sol.sain.cfg"), "tuned by hand");
write(path.join(CLIENT, "BepInEx", "config", "com.other.mod.cfg"), "also tuned");
write(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "Presets", "my-preset.json"), '{"difficulty":"hard"}');
write(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll"), "binary");
write(path.join(CLIENT, "BepInEx", "plugins", "dvize.Donuts", "Config", "spawns.json"), '{"waves":9}');
write(path.join(SERVER, "user", "mods", "platinum-theblacklist", "config", "config.json"), '{"blacklist":true}');
write(path.join(SERVER, "user", "mods", "platinum-theblacklist", "package.json"), '{"version":"3.0.1"}');

console.log("finding configuration");
const dirs = collectConfigPaths(CLIENT, SERVER);
check("found BepInEx/config", dirs.some((d) => d.endsWith(path.join("BepInEx", "config"))), true);
check("found a preset folder inside a plugin", dirs.some((d) => d.endsWith(path.join("SAIN", "Presets"))), true);
check("found a Config folder inside a plugin", dirs.some((d) => d.endsWith(path.join("dvize.Donuts", "Config"))), true);
check("found a server mod's config", dirs.some((d) => d.includes("platinum-theblacklist")), true);

console.log("\nbacking up");
const backup = backupConfigs(CLIENT, SERVER);
check("backed up every config file", backup.files, 5);
check("backup directory exists", fs.existsSync(backup.dir), true);

console.log("\nsimulating the reinstall: mod folders are replaced wholesale");
fs.rmSync(path.join(CLIENT, "BepInEx", "plugins", "SAIN"), { recursive: true, force: true });
write(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll"), "new binary");
write(path.join(CLIENT, "BepInEx", "config", "me.sol.sain.cfg"), "DEFAULTS");
fs.rmSync(path.join(SERVER, "user", "mods", "platinum-theblacklist"), { recursive: true, force: true });
write(path.join(SERVER, "user", "mods", "platinum-theblacklist", "package.json"), '{"version":"3.1.0"}');
// A mod that is no longer installed at all — its config must NOT be resurrected.
fs.rmSync(path.join(CLIENT, "BepInEx", "plugins", "dvize.Donuts"), { recursive: true, force: true });

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null);
check("SAIN preset was destroyed by the reinstall", read(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "Presets", "my-preset.json")), null);
check("cfg was reset to defaults", read(path.join(CLIENT, "BepInEx", "config", "me.sol.sain.cfg")), "DEFAULTS");

console.log("\nrestoring");
const restored = restoreConfigs(CLIENT, SERVER, backup.dir);
check("tuned cfg is back", read(path.join(CLIENT, "BepInEx", "config", "me.sol.sain.cfg")), "tuned by hand");
check("other cfg untouched and back", read(path.join(CLIENT, "BepInEx", "config", "com.other.mod.cfg")), "also tuned");
// The preset lives inside the folder the reinstall replaced — the case that is easy to miss.
check("SAIN preset restored inside the new folder", read(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "Presets", "my-preset.json")), '{"difficulty":"hard"}');
check("server mod config restored", read(path.join(SERVER, "user", "mods", "platinum-theblacklist", "config", "config.json")), '{"blacklist":true}');
check("the new binary was NOT overwritten", read(path.join(CLIENT, "BepInEx", "plugins", "SAIN", "SAIN.dll")), "new binary");
check("the new server package.json survived", read(path.join(SERVER, "user", "mods", "platinum-theblacklist", "package.json")), '{"version":"3.1.0"}');
// Restoring into a folder that no longer exists would recreate a ghost mod directory.
check("uninstalled mod's folder NOT recreated", fs.existsSync(path.join(CLIENT, "BepInEx", "plugins", "dvize.Donuts")), false);
check("restored count excludes the vanished mod", restored, 4);

console.log("\ndisabled mods must not come back as a second, enabled copy");
{
  // Reinstalling always writes to the ENABLED location. Without putting the mod back where
  // it was, a disabled mod ends up installed twice — one disabled (the old one) and one
  // enabled (the new one), which is what happened to LootingBots.
  const { toggleMod, resolveModPath } = require(path.join(dist, "modManager.js"));
  const inst = path.join(root, "inst2");
  write(path.join(inst, "BepInEx", "plugins.disabled", "skwizzy.LootingBots.dll"), "OLD disabled copy");
  // The reinstall lands here, enabled.
  write(path.join(inst, "BepInEx", "plugins", "skwizzy.LootingBots.dll"), "NEW copy");

  const mod = { id: "skwizzy.LootingBots.dll", name: "skwizzy.LootingBots", type: "client", enabled: true };
  const stale = resolveModPath(inst, inst, { id: mod.id, type: mod.type, enabled: false });
  if (fs.existsSync(stale)) fs.rmSync(stale, { recursive: true, force: true });
  const res = toggleMod(inst, inst, mod);

  check("toggle back to disabled succeeded", res.success, true);
  check("no enabled copy left", fs.existsSync(path.join(inst, "BepInEx", "plugins", "skwizzy.LootingBots.dll")), false);
  check("exactly one disabled copy", fs.existsSync(path.join(inst, "BepInEx", "plugins.disabled", "skwizzy.LootingBots.dll")), true);
  check(
    "and it is the NEW build, not the stale one",
    fs.readFileSync(path.join(inst, "BepInEx", "plugins.disabled", "skwizzy.LootingBots.dll"), "utf-8"),
    "NEW copy"
  );
}

console.log("\neligibility");
const mods = [
  { id: "Real", type: "client", manifestOnly: false },
  { id: "Orphan", type: "client", manifestOnly: true }
];
check("manifest-only mods are excluded", reinstallableMods(mods).length, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
