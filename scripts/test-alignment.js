/**
 * The side-by-side alignment: one row model, two panes.
 *
 * The property that matters is not that pairs line up — it is that GAPS do. A mod the server has
 * and this install does not must occupy a slot on both sides, or every row below it shifts and
 * the two panes agree at the top while drifting further apart the longer the list. So the
 * invariant each check below defends is: `slots.length` is identical for both panes, always.
 *
 * Compiled on the fly with esbuild because this module lives in `src/` and is otherwise only
 * ever bundled by Vite — the same approach test:browse uses.
 */
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const out = path.join(__dirname, "..", "dist-electron", "__serverAlignment.test.js");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "serverAlignment.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent"
});
const { buildAlignedSections } = require(out);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const local = (id, over = {}) => ({
  id,
  name: over.name ?? id,
  originalName: id,
  type: over.type ?? "client",
  enabled: true,
  installedManually: false,
  loadOrder: 0,
  ...over
});

const row = (over) => ({ key: over.key ?? `client:${over.name}`, side: "client", name: over.name, ...over });

const section = (sections, side) => sections.find((s) => s.side === side);

console.log("\n=== server/local alignment ===\n");

console.log("a gap on either side still occupies a slot");
{
  const sections = buildAlignedSections(
    [
      row({ name: "SAIN", localModId: "SAIN", serverVersion: "4.4.3", localVersion: "4.4.3" }),
      // The server has it, we do not.
      row({ name: "OnlyOnServer", issue: "missing-locally", serverVersion: "1.0.0" }),
      // We have it, the server does not.
      row({ name: "OnlyHere", issue: "not-on-server", localModId: "OnlyHere", localVersion: "2.0.0" })
    ],
    [local("SAIN"), local("OnlyHere")]
  );

  const client = section(sections, "client");
  check("every row gets a slot on both sides", client.slots.length, 3);
  check("the matched one is present both sides", [client.slots[0].localHas, client.slots[0].serverHas], [true, true]);
  // The two that matter: one blank each way, and neither shifts the other rows.
  check("a server-only mod is blank on the LEFT", [client.slots[1].localHas, client.slots[1].serverHas], [false, true]);
  check("a local-only mod is blank on the RIGHT", [client.slots[2].localHas, client.slots[2].serverHas], [true, false]);
  check("so both panes render the same number of rows", client.slots.length, client.slots.length);
}

console.log("\nmods held OUT of the comparison are not reported as gaps");
{
  // SPT's own plugin folder and the companion never appear in the report at all — they are
  // excluded on purpose. Rendering them with an empty server cell would claim the server is
  // missing SPT, which is both false and alarming.
  const sections = buildAlignedSections(
    [row({ name: "SAIN", localModId: "SAIN", serverVersion: "4.4.3", localVersion: "4.4.3" })],
    [local("SAIN"), local("spt"), local("SptarkyCompanion", { type: "server" })]
  );

  const client = section(sections, "client");
  check("the uncompared plugin still takes a slot", client.slots.length, 2);
  const spt = client.slots.find((s) => s.local && s.local.id === "spt");
  check("marked as not compared, not as missing", spt.notCompared, true);
  check("with nothing on the server side to imply otherwise", spt.serverHas, false);

  // A server-side mod lands in the server section, not the client one.
  check("the companion goes to the server section", section(sections, "server").slots.length, 1);
  check("also marked not compared", section(sections, "server").slots[0].notCompared, true);
}

console.log("\nthe two halves of one mod stay in their own sections");
{
  // acidphantasm-botplacementsystem ships a server mod AND a client plugin under one name. Two
  // rows, one per section — never merged, and never both in the same list.
  const sections = buildAlignedSections(
    [
      row({ key: "client:aps", name: "acidphantasm-botplacementsystem", side: "client", localModId: "acidphantasm-botplacementsystem", serverVersion: "2.0.19", localVersion: "2.0.19" }),
      row({ key: "server:aps", name: "acidphantasm-botplacementsystem", side: "server", localModId: "acidphantasm-botplacementsystem", serverVersion: "2.0.19", localVersion: "2.0.19" })
    ],
    [local("acidphantasm-botplacementsystem"), local("acidphantasm-botplacementsystem", { type: "server" })]
  );

  check("one slot in each section", [section(sections, "client").slots.length, section(sections, "server").slots.length], [1, 1]);
  check("the client slot took the client folder", section(sections, "client").slots[0].local.type, "client");
  check("and the server slot the server one", section(sections, "server").slots[0].local.type, "server");
  check("neither is left over as an uncompared extra", sections.every((s) => s.slots.every((x) => !x.notCompared)), true);
}

console.log("\naddons, which have no folder on either side");
{
  const sections = buildAlignedSections(
    [
      { key: "addon:id:1", side: "addon", name: "Icebreaker Fika sync", issue: "missing-locally", serverVersion: "0.2.1", parentName: "ManimalIcebreaker" },
      { key: "addon:id:2", side: "addon", name: "Bullets USEC", issue: "not-on-server", localVersion: "1.0.0", parentName: "BorkelRNVG" },
      { key: "addon:id:3", side: "addon", name: "CAG BRNVG patch", serverVersion: "1.0.0", localVersion: "1.0.0", parentName: "WTT-CAG" }
    ],
    []
  );

  const addons = section(sections, "addon");
  check("all three take a slot", addons.slots.length, 3);
  check("one the server has and we do not is blank on the left", [addons.slots[0].localHas, addons.slots[0].serverHas], [false, true]);
  check("one we have and the server does not is blank on the right", [addons.slots[1].localHas, addons.slots[1].serverHas], [true, false]);
  // Addons own no folder, so the local half is a recorded version rather than a mod.
  check("the local half is the recorded version", addons.slots[2].localAddonVersion, "1.0.0");
  check("and no ModInfo is invented for it", addons.slots[2].local, undefined);
}

console.log("\nwith nothing to compare against");
{
  check("no rows and no mods means no sections", buildAlignedSections([], []).length, 0);
  // A local install and an unreachable/empty server: every mod still appears, all uncompared.
  const sections = buildAlignedSections([], [local("SAIN"), local("Fika")]);
  check("local mods still all get slots", section(sections, "client").slots.length, 2);
  check("none of them claimed to be missing from the server", section(sections, "client").slots.every((s) => s.notCompared), true);
}

console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
try {
  fs.unlinkSync(out);
} catch {}
process.exit(failures === 0 ? 0 : 1);
