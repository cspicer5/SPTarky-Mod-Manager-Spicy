/**
 * Where mods, addons and payloads land across SPT layouts.
 *
 * SPT 4.1.x renamed the server folder from `<root>/SPT` to `<root>/SPT_Runtime`. Nothing in
 * the app matches on that name — the server root is found by looking for SPT.Server.exe or a
 * `user/` folder — so the rename needed no code change. This test exists to keep it that way,
 * because the failure mode is silent: a server mod written under the CLIENT root sits in a
 * folder the server never reads, the install reports success, and the mod simply does nothing.
 *
 * Verified against both real installs when written: D:\SPT resolves to SPT\SPT, D:\SPT41 to
 * SPT41\SPT_Runtime.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require(path.join(__dirname, "..", "node_modules", "adm-zip"));

const dist = path.join(__dirname, "..", "dist-electron");
const M = require(path.join(dist, "modManager.js"));
const P = require(path.join(dist, "presetPayloads.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-layout-"));

/** Builds a split install whose server folder is called `serverDirName`. */
function makeInstall(label, serverDirName) {
  const client = path.join(root, label);
  const server = path.join(client, serverDirName);
  fs.mkdirSync(path.join(client, "BepInEx", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(client, "EscapeFromTarkov.exe"), "");
  fs.mkdirSync(path.join(server, "user", "mods"), { recursive: true });
  fs.writeFileSync(path.join(server, "SPT.Server.exe"), "");
  return { client, server };
}

function hybridArchive(name, serverFolder, clientFolder) {
  const zip = new AdmZip();
  zip.addFile(`user/mods/${serverFolder}/package.json`, Buffer.from(JSON.stringify({ name: serverFolder, version: "1.0.0" })));
  zip.addFile(`user/mods/${serverFolder}/src/mod.js`, Buffer.from("//"));
  zip.addFile(`BepInEx/plugins/${clientFolder}/${clientFolder}.dll`, Buffer.from("binary"));
  const p = path.join(root, `${name}.zip`);
  zip.writeZip(p);
  return p;
}

async function main() {
  // 4.1.x, 4.0.x, and a name nobody has used yet. All three resolve by MARKERS, so a future
  // rename should need no code change either.
  for (const [label, dirName] of [
    ["spt41", "SPT_Runtime"],
    ["spt40", "SPT"],
    ["future", "Server_v5"]
  ]) {
    console.log(`\nserver folder named "${dirName}"`);
    const { client, server } = makeInstall(label, dirName);

    const resolved = M.resolveSptInstance(client);
    check("resolves", !!resolved, true);
    check("finds the right server root", resolved.instance.serverRoot, server);
    check("recognises it as split", resolved.instance.split, true);

    const archive = hybridArchive(`mod-${label}`, `srv-${label}`, `cli-${label}`);
    const result = await M.installModFromArchive(resolved.instance.clientRoot, resolved.instance.serverRoot, archive);
    check("hybrid install succeeds", result.success, true);
    check("server half under the server root", fs.existsSync(path.join(server, "user", "mods", `srv-${label}`, "package.json")), true);
    check("client half under the client root", fs.existsSync(path.join(client, "BepInEx", "plugins", `cli-${label}`, `cli-${label}.dll`)), true);
    // The silent failure: written where the server never looks, reported as success.
    check("no stray server copy beside the client", fs.existsSync(path.join(client, "user", "mods", `srv-${label}`)), false);

    const scanned = M.scanMods(resolved.instance.clientRoot, resolved.instance.serverRoot);
    check("both halves are found by a scan", scanned.length, 2);
  }

  console.log("\nan addon unpacking INTO its parent's folder, on 4.1.x");
  {
    // The shape most addons take: no folder of their own, files dropped inside the parent.
    const { client, server } = makeInstall("addon41", "SPT_Runtime");
    const { clientRoot, serverRoot } = M.resolveSptInstance(client).instance;

    await M.installModFromArchive(clientRoot, serverRoot, hybridArchive("parent41", "WTT-CAG", "SAIN"));

    const patch = new AdmZip();
    patch.addFile("user/mods/WTT-CAG/db/patch.json", Buffer.from('{"patched":true}'));
    patch.addFile("BepInEx/plugins/SAIN/Presets/custom.json", Buffer.from("{}"));
    const patchPath = path.join(root, "patch41.zip");
    patch.writeZip(patchPath);
    const r = await M.installModFromArchive(clientRoot, serverRoot, patchPath);
    check("patch installs", r.success, true);
    check("server-side patch inside the server root", fs.existsSync(path.join(server, "user", "mods", "WTT-CAG", "db", "patch.json")), true);
    check("client-side patch inside the client root", fs.existsSync(path.join(client, "BepInEx", "plugins", "SAIN", "Presets", "custom.json")), true);
    check("the parent's own files survive", fs.existsSync(path.join(server, "user", "mods", "WTT-CAG", "package.json")), true);
    check("nothing stray beside the client", fs.existsSync(path.join(client, "user", "mods")), false);
    check("nothing stray under the server", fs.existsSync(path.join(server, "BepInEx")), false);
  }

  console.log("\npreset payloads on 4.1.x");
  {
    const { client, server } = makeInstall("payload41", "SPT_Runtime");
    const { clientRoot, serverRoot } = M.resolveSptInstance(client).instance;
    await M.installModFromArchive(clientRoot, serverRoot, hybridArchive("pl41", "SrvMod", "CliMod"));

    // resolvePayloadTarget has its OWN splitting rule, separate from the installer's, so a
    // rename could be handled in one place and missed in the other.
    check(
      "user/ maps to the server root",
      P.resolvePayloadTarget("user/mods/x/a.js", clientRoot, serverRoot, true),
      path.join(serverRoot, "user", "mods", "x", "a.js")
    );
    check(
      "BepInEx/ maps to the client root",
      P.resolvePayloadTarget("BepInEx/plugins/y/b.dll", clientRoot, serverRoot, true),
      path.join(clientRoot, "BepInEx", "plugins", "y", "b.dll")
    );

    const store = path.join(root, "store41");
    fs.mkdirSync(store, { recursive: true });
    const files = P.collectModPayloadFiles(clientRoot, serverRoot, {
      id: "SrvMod",
      type: "server",
      enabled: true,
      name: "SrvMod",
      originalName: "SrvMod"
    });
    check("gathers the server mod from the renamed folder", files.length, 2);

    const stored = await P.storePayload(store, files, { name: "SrvMod", version: "1.0.0", type: "server" });
    check("payload stored", stored.success, true);

    const t = path.join(root, "target41");
    const ts = path.join(t, "SPT_Runtime");
    fs.mkdirSync(t, { recursive: true });
    const applied = await P.applyPayload(store, stored.key, t, ts, { enabled: true });
    check("payload applies", applied.success, true);
    check("into the target's server root", fs.existsSync(path.join(ts, "user", "mods", "SrvMod", "package.json")), true);
    check("and not beside its client root", fs.existsSync(path.join(t, "user")), false);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err?.stack ?? err);
  process.exit(1);
});
