/**
 * Preset capture and reconciliation, against synthetic mod lists.
 *
 * The interesting cases are the ones a real install will not reliably produce on demand:
 * a mod renamed between capture and apply (matched by GUID), a mod shipping a server and a
 * client half under one folder name, and an optional mod missing versus a required one.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const { createPreset, buildPresetReport, listPresets, readPreset, updatePreset, deletePreset, slugify } = require(
  path.join(dist, "presets.js")
);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-presets-"));

const mod = (id, type, version, enabled = true, guid = undefined) => ({
  id,
  name: id,
  originalName: id,
  type,
  enabled,
  installedManually: false,
  loadOrder: 99,
  version,
  guid
});

const INSTALLED = [
  mod("SAIN", "client", "4.4.3", true, "me.sol.sain"),
  mod("DrakiaXYZ-BigBrain.dll", "client", "1.4.0", true, "xyz.drakia.bigbrain"),
  mod("AmandsGraphics", "client", "1.7.0", false),
  // The collision case: one folder name, two sides.
  mod("acidphantasm-botplacementsystem", "client", "2.0.19"),
  mod("acidphantasm-botplacementsystem", "server", "2.0.19"),
  mod("fika-server", "server", "2.3.5", true, "Fika")
];

console.log("capture");
const preset = createPreset(root, INSTALLED, { name: "Stable Co-op", description: "Tuesday group", optional: ["AmandsGraphics"] });
// The hyphen in "Co-op" is already a separator, so it survives as one.
check("id is a slug", preset.id, "stable-co-op");
check("captured every mod", preset.mods.length, 6);
check("optional flag honoured", preset.mods.find((m) => m.name === "AmandsGraphics")?.required, false);
check("everything else required", preset.mods.find((m) => m.name === "SAIN")?.required, true);
check("both halves of the collision captured", preset.mods.filter((m) => m.name === "acidphantasm-botplacementsystem").length, 2);
check("enabled state captured", preset.mods.find((m) => m.name === "AmandsGraphics")?.enabled, false);
check("appears in the list", listPresets(root).length, 1);
check("round-trips from disk", readPreset(root, preset.id)?.name, "Stable Co-op");

console.log("\nan install that already matches");
let report = buildPresetReport(preset, INSTALLED);
check("satisfied", report.satisfied, true);
check("everything matching", report.counts.matching, 6);
check("nothing missing", report.counts.missing, 0);
check("nothing extra", report.counts.extra, 0);

console.log("\na required mod is missing");
report = buildPresetReport(preset, INSTALLED.filter((m) => m.id !== "SAIN"));
check("not satisfied", report.satisfied, false);
check("counted as missing", report.counts.missing, 1);
check("counted as REQUIRED missing", report.counts.missingRequired, 1);
check("required gap sorts first", report.rows[0].name, "SAIN");

console.log("\nonly an optional mod is missing");
report = buildPresetReport(preset, INSTALLED.filter((m) => m.id !== "AmandsGraphics"));
// An optional mod is part of the setup but not a barrier to playing, so its absence must not
// read the same as a required one.
check("still satisfied", report.satisfied, true);
check("still reported as missing", report.counts.missing, 1);
check("but not as a required gap", report.counts.missingRequired, 0);

console.log("\nversion and state differences");
report = buildPresetReport(preset, [
  ...INSTALLED.filter((m) => m.id !== "SAIN" && m.id !== "AmandsGraphics"),
  mod("SAIN", "client", "4.4.1", true, "me.sol.sain"),
  mod("AmandsGraphics", "client", "1.7.0", true)
]);
check("version mismatch found", report.counts.versionMismatch, 1);
check("state mismatch found", report.counts.stateMismatch, 1);
check("not satisfied", report.satisfied, false);

console.log("\nthe folder was renamed, but the GUID still matches");
report = buildPresetReport(preset, [
  ...INSTALLED.filter((m) => m.id !== "SAIN"),
  mod("SAIN-renamed-by-hand", "client", "4.4.3", true, "me.sol.sain")
]);
const sain = report.rows.find((r) => r.name === "SAIN");
check("matched despite the rename", sain?.issue ?? "none", "none");
check("matched by guid", sain?.matchedBy, "guid");
check("not reported as extra", report.counts.extra, 0);

console.log("\nserver/client halves stay separate");
report = buildPresetReport(
  preset,
  INSTALLED.filter((m) => !(m.id === "acidphantasm-botplacementsystem" && m.type === "client"))
);
const halves = report.rows.filter((r) => r.name === "acidphantasm-botplacementsystem");
check("still two rows", halves.length, 2);
check("only the client half is missing", halves.filter((r) => r.issue === "missing").length, 1);
check("the missing one is the client half", halves.find((r) => r.issue === "missing")?.type, "client");

console.log("\nan extra mod is reported, never treated as an error");
report = buildPresetReport(preset, [...INSTALLED, mod("SomethingElse", "client", "1.0.0")]);
check("counted as extra", report.counts.extra, 1);
check("still satisfied", report.satisfied, true);

console.log("\nupdating a preset keeps its identity and its optional flags");
const updated = updatePreset(root, preset.id, INSTALLED.filter((m) => m.id !== "fika-server"));
check("same id", updated?.id, preset.id);
check("recaptured", updated?.mods.length, 5);
check("optional flag survived the recapture", updated?.mods.find((m) => m.name === "AmandsGraphics")?.required, false);
check("createdAt preserved", updated?.createdAt, preset.createdAt);
check("no duplicate preset left behind", listPresets(root).length, 1);

console.log("\nslugs");
check("spaces and case", slugify("Stable Co-op"), "stable-co-op");
check("punctuation stripped", slugify("!!! weird ### name !!!"), "weird-name");
check("empty falls back", slugify("???"), "preset");

console.log("\ndelete");
check("deleted", deletePreset(root, preset.id).success, true);
check("list is empty", listPresets(root).length, 0);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
