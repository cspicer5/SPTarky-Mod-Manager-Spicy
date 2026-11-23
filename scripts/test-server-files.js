/**
 * Pulling a mod's files from the server it is joining.
 *
 * The properties worth pinning are all about NOT half-installing something. A download that
 * stops early is the failure that keeps quiet: it leaves a plausible folder behind, the scanner
 * reads it as installed, and the ledger records a version whose files are incomplete. So every
 * check below is about refusing rather than about the happy path.
 *
 * Runs against a stub HTTP server rather than a real SPT one — the contract is what is being
 * tested, and a test that needs someone's game server running is a test that does not run.
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listServerModFiles, installModFromServer, installAddonFromServer, fetchServerModFile } = require(path.join(__dirname, "..", "dist-electron", "serverFiles.js"));
const { serverPatchers, serverPatchersOwnedBy, pullPrepatchersFromServer } = require(path.join(__dirname, "..", "dist-electron", "serverPatchers.js"));
const { buildAssembly } = require("./fake-assembly");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

/**
 * Files the stub will serve, and how it should misbehave.
 *
 * `singles` and `folders` are addressed entries ("half/id"), answered the way the real companion
 * does: a single file is listed only by 1.3.0 (1.2.0 says "No such mod" for it) but its bytes are
 * served by both, and a path INSIDE a single file is not found. Anything else falls back to
 * `files`, which every older check in this suite uses for whatever id it asks about.
 */
const state = { files: {}, truncate: null, fail: null, listError: null, extraPath: null, companion: "1.2.0", singles: {}, folders: {}, requests: [] };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url ?? "");
  state.requests.push(url);
  const json = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.includes("/sptarky/filelist/")) {
    const [half, id] = url.split("/sptarky/filelist/")[1].split("/");
    const single = state.singles[`${half}/${id}`];
    if (single) {
      return json(state.companion === "1.3.0" ? { kind: "file", files: [{ path: id, sizeBytes: single.length }] } : { files: [], error: "No such mod on this server." });
    }
    const folder = state.folders[`${half}/${id}`];
    if (folder) return json({ kind: "folder", files: Object.entries(folder).map(([p, b]) => ({ path: p, sizeBytes: b.length })) });
  }
  if (url.includes("/sptarky/filedata/")) {
    const segs = url.split("/sptarky/filedata/")[1].split("/");
    const single = state.singles[`${segs[0]}/${segs[1]}`];
    if (single) {
      if (segs.length === 2) {
        res.writeHead(200);
        res.end(state.truncate === segs[1] ? single.subarray(0, single.length - 3) : single);
        return;
      }
      // What the companion answers for a path inside a FILE: no such file, as JSON with a 200.
      return json({ files: [], error: "No such file." });
    }
    const folder = state.folders[`${segs[0]}/${segs[1]}`];
    if (folder) {
      const body = folder[segs.slice(2).join("/")];
      res.writeHead(body ? 200 : 404);
      res.end(body ?? undefined);
      return;
    }
  }
  if (url.includes("/sptarky/filelist/")) {
    if (state.listError) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files: [], error: state.listError }));
      return;
    }
    const files = Object.entries(state.files).map(([p, buf]) => ({ path: p, sizeBytes: buf.length }));
    if (state.extraPath) files.push({ path: state.extraPath, sizeBytes: 4 });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files }));
    return;
  }
  if (url.includes("/sptarky/filedata/")) {
    const rel = url.split("/sptarky/filedata/")[1].split("/").slice(2).join("/");
    if (state.fail === rel) {
      res.writeHead(500);
      res.end();
      return;
    }
    const buf = state.files[rel] ?? Buffer.from("xxxx");
    res.writeHead(200);
    // Truncation is deliberate here, because it is the failure that does not announce itself.
    res.end(state.truncate === rel ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf);
    return;
  }
  res.writeHead(404);
  res.end();
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-pull-"));

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  console.log("\n=== pulling a mod from the server ===\n");

  console.log("a clean pull");
  {
    state.files = {
      "Mod.dll": Buffer.from("MZ binary content here"),
      "config/settings.json": Buffer.from('{"a":1}'),
      "bundles/big.bundle": Buffer.alloc(5000, 7)
    };
    state.truncate = state.fail = state.listError = state.extraPath = null;

    const listing = await listServerModFiles(origin, "client", "MyMod");
    check("the listing arrives", listing.files.length, 3);

    const result = await installModFromServer(origin, "client", "MyMod", tmp);
    check("it succeeds", result.success, true);
    check("with every file", result.files, 3);
    check("and the byte count", result.bytes, 22 + 7 + 5000);
    // Nested paths must survive: a mod's own folder structure is part of the mod.
    check("nested files land in their folders", fs.existsSync(path.join(tmp, "MyMod", "config", "settings.json")), true);
    check("binary content is unmangled", fs.readFileSync(path.join(tmp, "MyMod", "Mod.dll")).toString(), "MZ binary content here");
    check("and a large file is intact", fs.statSync(path.join(tmp, "MyMod", "bundles", "big.bundle")).size, 5000);
  }

  console.log("\na truncated download is refused, not written");
  {
    // The important one. A short file is indistinguishable from a good one afterwards, so it has
    // to be caught by size at the moment it arrives or never.
    fs.rmSync(path.join(tmp, "Truncated"), { recursive: true, force: true });
    state.files = { "Mod.dll": Buffer.from("0123456789") };
    state.truncate = "Mod.dll";

    const result = await installModFromServer(origin, "client", "Truncated", tmp);
    check("it fails", result.success, false);
    check("saying which file and by how much", /expected 10 bytes, got 7/.test(result.message), true);
    check("and NOTHING is left behind", fs.existsSync(path.join(tmp, "Truncated")), false);
    state.truncate = null;
  }

  console.log("\nan existing install survives a failed pull");
  {
    // Staging exists for this: a mod that is already working must not be destroyed by a download
    // that then fails halfway.
    const existing = path.join(tmp, "Existing");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "keep.txt"), "the copy that already worked");

    state.files = { "a.dll": Buffer.from("aaaa"), "b.dll": Buffer.from("bbbb") };
    state.fail = "b.dll";

    const result = await installModFromServer(origin, "client", "Existing", tmp);
    check("the pull fails", result.success, false);
    check("and the working copy is untouched", fs.readFileSync(path.join(existing, "keep.txt"), "utf-8"), "the copy that already worked");
    state.fail = null;
  }

  console.log("\nrefusing what should never be written");
  {
    // The server resolves paths safely, but a client writing files cannot depend on a remote
    // machine having got that right.
    state.files = { "ok.dll": Buffer.from("aaaa") };
    state.extraPath = "../escaped.dll";
    const escape = await installModFromServer(origin, "client", "Escapee", tmp);
    check("a file outside the mod folder is rejected", escape.success, false);
    check("named in the message", /outside the mod folder/.test(escape.message), true);
    check("and nothing escaped", fs.existsSync(path.join(tmp, "escaped.dll")), false);
    state.extraPath = null;

    // A mod id is a folder name. A separator in one would place files anywhere writable.
    const traversal = await installModFromServer(origin, "client", "../evil", tmp);
    check("a mod id with a separator is refused outright", traversal.success, false);
    check("before anything is requested", /not a valid mod folder name/.test(traversal.message), true);
  }

  console.log("\nwhen the server simply does not have it");
  {
    state.listError = "No such mod on this server.";
    const result = await installModFromServer(origin, "client", "Absent", tmp);
    check("that is reported as-is", result.success, false);
    check("in the server's own words", result.message, "No such mod on this server.");
    state.listError = null;
  }

  console.log("\npulling an ADDON that merged into its parent");
  {
    // The half that could not exist until addons recorded their files. A merged addon has no
    // folder, so "fetch the addon" means fetching the individual files inside its PARENT that
    // the serving machine recorded as its.
    const parentDir = path.join(tmp, "BepInEx", "plugins", "TheParent");
    fs.mkdirSync(path.join(parentDir, "Assets"), { recursive: true });
    fs.writeFileSync(path.join(parentDir, "parent.dll"), "the parent's own file");
    fs.writeFileSync(path.join(parentDir, "Assets", "shipped.bundle"), "parent content");

    state.files = {
      "parent.dll": Buffer.from("the parent's own file"),
      "Assets/shipped.bundle": Buffer.from("PATCHED by the addon"),
      "Assets/patch.dll": Buffer.from("new from the addon")
    };

    const addon = {
      name: "The Patch",
      parentName: "TheParent",
      parentHalf: "client",
      mergedIntoParent: true,
      parentFiles: ["Assets/shipped.bundle", "Assets/patch.dll"],
      folders: []
    };
    const targetRootFor = (half) =>
      half === "server" ? path.join(tmp, "user", "mods") : path.join(tmp, "BepInEx", "plugins");

    const r = await installAddonFromServer(origin, addon, parentDir, targetRootFor);
    check("the pull succeeds", r.success, true);
    check("the added file landed", fs.existsSync(path.join(parentDir, "Assets", "patch.dll")), true);
    // The case that makes this worth having: a patch that OVERWRITES what the parent ships.
    check("the overwritten file was replaced", fs.readFileSync(path.join(parentDir, "Assets", "shipped.bundle"), "utf-8"), "PATCHED by the addon");
    // Only the addon's files. The parent must survive having a patch applied to it.
    check("a parent file the addon does not own is untouched", fs.readFileSync(path.join(parentDir, "parent.dll"), "utf-8"), "the parent's own file");
    check("no staging folder left behind", fs.existsSync(path.join(parentDir, ".sptarky-addon-pull")), false);
  }

  console.log("\nan addon pull refuses rather than half-applying");
  {
    const parentDir = path.join(tmp, "BepInEx", "plugins", "TheParent");
    const targetRootFor = () => path.join(tmp, "BepInEx", "plugins");
    const base = { name: "The Patch", parentName: "TheParent", parentHalf: "client", mergedIntoParent: true, folders: [] };

    // These paths are chosen by ANOTHER machine, so they are input rather than data.
    const escape = await installAddonFromServer(origin, { ...base, parentFiles: ["../../../evil.txt"] }, parentDir, targetRootFor);
    check("a traversing path is refused", escape.success, false);
    check("and nothing was written outside the parent", fs.existsSync(path.join(tmp, "evil.txt")), false);

    // Empty is not "it touched nothing" — it is "that machine cannot say", and the fix is there.
    const empty = await installAddonFromServer(origin, { ...base, parentFiles: [] }, parentDir, targetRootFor);
    check("an empty file list is refused", empty.success, false);
    check("and says the record is the problem", /no record of which files/.test(empty.message), true);

    // A recorded file the server no longer has means its copy is not the one its ledger
    // describes. Applying the rest would produce a patch that exists on neither machine.
    state.files = { "Assets/patch.dll": Buffer.from("new from the addon") };
    const partial = await installAddonFromServer(
      origin,
      { ...base, parentFiles: ["Assets/patch.dll", "Assets/vanished.dll"] },
      parentDir,
      targetRootFor
    );
    check("a file the server has lost refuses the whole pull", partial.success, false);
    check("and nothing was applied", fs.existsSync(path.join(parentDir, "Assets", "vanished.dll")), false);

    const noParent = await installAddonFromServer(origin, { ...base, parentFiles: ["a.dll"] }, path.join(tmp, "NotInstalled"), targetRootFor);
    check("a parent that is not installed here is refused", noParent.success, false);
    check("and says to install it first", /Install it first/.test(noParent.message), true);
  }

  console.log("\na mod that is ONE file (ShowMeTheMoney's client half)");
  {
    const plugins = path.join(tmp, "single", "BepInEx", "plugins");
    const staging = path.join(tmp, "single", "BepInEx", ".sptarky-pull");
    const dll = Buffer.from("MZ SwiftXP.ShowMeTheMoney build from the server");
    state.singles = { "client/SwiftXP.ShowMeTheMoney.dll": dll };
    state.companion = "1.2.0";
    state.requests = [];

    // The reported failure, as the companion the server runs today answers it.
    const listed = await listServerModFiles(origin, "client", "SwiftXP.ShowMeTheMoney.dll");
    check("a 1.2.0 companion's file list refuses a single file", listed.error, "No such mod on this server.");
    const blind = await installModFromServer(origin, "client", "SwiftXP.ShowMeTheMoney.dll", plugins);
    check("so a pull that asks the list first still fails against it", blind.success, false);

    // The fix that works against that same companion: the manifest's kind and size, then the data
    // route, which has always served a single file.
    state.requests = [];
    const pulled = await installModFromServer(origin, "client", "SwiftXP.ShowMeTheMoney.dll", plugins, {
      entry: { kind: "file", sizeBytes: dll.length },
      stagingRoot: staging
    });
    check("with the manifest's size it succeeds against 1.2.0", pulled.success, true);
    check("it lands as a FILE, not a folder of that name", fs.statSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll")).isFile(), true);
    check("with the server's exact bytes", fs.readFileSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll")).equals(dll), true);
    check("without asking for a file list", state.requests.some((u) => u.includes("/filelist/")), false);
    check("from the single-file address", state.requests, ["/sptarky/filedata/client/SwiftXP.ShowMeTheMoney.dll"]);
    check("and the staging folder outside plugins/ is gone", fs.existsSync(staging), false);

    // A 1.3.0 companion lists it, so a pull that has no manifest entry to go on works too.
    state.companion = "1.3.0";
    fs.rmSync(plugins, { recursive: true, force: true });
    const listed13 = await listServerModFiles(origin, "client", "SwiftXP.ShowMeTheMoney.dll");
    check("1.3.0 lists it as a file", [listed13.kind, listed13.files.map((f) => f.path)], ["file", ["SwiftXP.ShowMeTheMoney.dll"]]);
    const viaList = await installModFromServer(origin, "client", "SwiftXP.ShowMeTheMoney.dll", plugins);
    check("and a pull from the list alone succeeds", viaList.success, true);
    check("as a file", fs.statSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll")).isFile(), true);
    check("leaving no .part file in plugins/", fs.readdirSync(plugins).filter((n) => n.endsWith(".part")), []);

    // An UPDATE: an older copy is already there, and a good download replaces it.
    fs.writeFileSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll"), "an older build");
    const update = await installModFromServer(origin, "client", "SwiftXP.ShowMeTheMoney.dll", plugins, {
      entry: { kind: "file", sizeBytes: dll.length },
      stagingRoot: staging
    });
    check("an update replaces the older single file", [update.success, fs.readFileSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll")).equals(dll)], [true, true]);

    // A short download must not replace the copy that works.
    fs.writeFileSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll"), "the copy that already worked");
    state.truncate = "SwiftXP.ShowMeTheMoney.dll";
    const short = await installModFromServer(origin, "client", "SwiftXP.ShowMeTheMoney.dll", plugins, {
      entry: { kind: "file", sizeBytes: dll.length },
      stagingRoot: staging
    });
    check("a truncated single file is refused", short.success, false);
    check("saying by how much", /expected \d+ bytes, got \d+/.test(short.message), true);
    check("and the working copy is untouched", fs.readFileSync(path.join(plugins, "SwiftXP.ShowMeTheMoney.dll"), "utf-8"), "the copy that already worked");
    state.truncate = null;

    // An OLD manager against a 1.3.0 companion: it lists, then asks for the file INSIDE itself.
    // That must fail closed — nothing written — rather than write a JSON error as a DLL.
    const oldStyle = await fetchServerModFile(origin, "client", "SwiftXP.ShowMeTheMoney.dll", "SwiftXP.ShowMeTheMoney.dll", dll.length);
    check("an older manager's request for a path inside the file gets no file", oldStyle.ok, false);

    // A single-DLL own-folder addon (Quick Sell) goes through the same pull.
    state.companion = "1.2.0";
    const quickSell = Buffer.from("MZ Quick Sell");
    state.singles["client/SwiftXP.SPT.ShowMeTheMoney.QuickSell.dll"] = quickSell;
    const addon = await installAddonFromServer(
      origin,
      { name: "Quick Sell (4.1.x)", parentName: "SwiftXP.ShowMeTheMoney.dll", parentHalf: "client", mergedIntoParent: false, parentFiles: [], folders: [{ id: "SwiftXP.SPT.ShowMeTheMoney.QuickSell.dll", half: "client" }] },
      path.join(plugins, "SwiftXP.ShowMeTheMoney.dll"),
      () => plugins,
      { entryFor: (half, id) => (id === "SwiftXP.SPT.ShowMeTheMoney.QuickSell.dll" ? { kind: "file", sizeBytes: quickSell.length } : undefined), stagingRootFor: () => staging }
    );
    check("a single-DLL own-folder addon pulls from a 1.2.0 companion", addon.success, true);
    check("as a file beside its parent", fs.readFileSync(path.join(plugins, "SwiftXP.SPT.ShowMeTheMoney.QuickSell.dll")).equals(quickSell), true);
    state.singles = {};
  }

  console.log("\nprepatchers come with the plugin, and what they reference comes too");
  {
    const asm = (name, refs = []) => buildAssembly({ name, refs: ["netstandard", ...refs] });
    const local = path.join(tmp, "pp-client");
    const staging = path.join(local, "BepInEx", ".sptarky-pull");
    const reset = () => {
      fs.rmSync(local, { recursive: true, force: true });
      for (const d of ["BepInEx/patchers", "BepInEx/plugins", "BepInEx/core", "EscapeFromTarkov_Data/Managed"]) fs.mkdirSync(path.join(local, d), { recursive: true });
    };
    state.companion = "1.3.0";
    state.folders = {
      "patchers/BlackDiv": { "BlackDiv.dll": asm("BlackDiv", ["MoreBotsPrepatch"]) },
      "patchers/MoreBotsPrepatch": { "MoreBotsPrepatch.dll": asm("MoreBotsPrepatch") },
      // Provides an assembly under a different entry name: found by asking for its file list.
      "patchers/GhostPack": { "GhostLib.dll": asm("GhostLib") }
    };
    const lonely = asm("Lonely", ["Nowhere"]);
    const needsGhost = asm("NeedsGhost", ["GhostLib"]);
    state.singles = { "patchers/Lonely.dll": lonely, "patchers/NeedsGhost.dll": needsGhost, "patchers/spt-prepatch.dll": asm("spt-prepatch") };

    const patcher = (id, kind, bytes) => ({ id, type: "client", area: "patchers", enabled: true, versionSource: "unknown", kind, ...(bytes ? { sizeBytes: bytes.length } : {}) });
    const snapshot = {
      clientMods: [
        { id: "BlackDivPlugin", type: "client", area: "plugins", enabled: true, versionSource: "declared", kind: "folder" },
        { id: "MoreBotsPlugin", type: "client", area: "plugins", enabled: true, versionSource: "declared", kind: "folder" },
        { id: "GhostMod", type: "client", area: "plugins", enabled: true, versionSource: "declared", kind: "folder" },
        patcher("BlackDiv", "folder"),
        patcher("MoreBotsPrepatch", "folder"),
        patcher("GhostPack", "folder"),
        patcher("Lonely.dll", "file", lonely),
        patcher("NeedsGhost.dll", "file", needsGhost),
        patcher("spt-prepatch.dll", "file")
      ],
      // The SERVER's install record: BlackDiv's archive put its prepatcher in, and so did MoreBots'.
      remoteLedgers: {
        registry: [
          { id: "BlackDivPlugin", type: "client", linkedModId: "k-blackdiv" },
          { id: "MoreBotsPlugin", type: "client", linkedModId: "k-morebots" },
          { id: "GhostMod", type: "client", linkedModId: "k-ghost" }
        ],
        installManifest: {
          "k-blackdiv": ["BepInEx/plugins/BlackDivPlugin/BlackDivPlugin.dll", "BepInEx/patchers/BlackDiv/BlackDiv.dll"],
          "k-morebots": ["BepInEx/plugins/MoreBotsPlugin/MoreBotsPlugin.dll", "BepInEx/patchers/MoreBotsPrepatch/MoreBotsPrepatch.dll"],
          "k-ghost": ["BepInEx/plugins/GhostMod/GhostMod.dll", "BepInEx/patchers/NeedsGhost.dll"]
        }
      }
    };

    check("SPT's own prepatcher is never offered", serverPatchers(snapshot).map((p) => p.id).includes("spt-prepatch.dll"), false);
    check(
      "the server's install record says which prepatcher is BlackDiv's",
      serverPatchersOwnedBy(["BlackDivPlugin"], snapshot).map((p) => p.id),
      ["BlackDiv"]
    );
    check("MoreBotsPrepatch shares no word with MoreBotsPlugin, and is still its", serverPatchersOwnedBy(["MoreBotsPlugin"], snapshot).map((p) => p.id), ["MoreBotsPrepatch"]);
    check("a prepatcher nobody can be shown to own is not pulled with a plugin", serverPatchersOwnedBy(["BlackDivPlugin", "MoreBotsPlugin"], snapshot).some((p) => p.id === "Lonely.dll"), false);

    // The incident, on a client: pull BlackDiv and its dependency arrives with it.
    reset();
    const r = await pullPrepatchersFromServer(origin, local, serverPatchers(snapshot), serverPatchersOwnedBy(["BlackDivPlugin"], snapshot), { stagingRoot: staging });
    check("BlackDiv's prepatcher and the one it references are both pulled", r.pulled, ["BlackDiv", "MoreBotsPrepatch"]);
    check("into BepInEx/patchers", fs.existsSync(path.join(local, "BepInEx", "patchers", "MoreBotsPrepatch", "MoreBotsPrepatch.dll")), true);
    check("leaving nothing unresolved", r.unresolved, []);
    check("and no staging folder", fs.existsSync(staging), false);

    // A provider whose entry is named differently is found through its file list.
    reset();
    const g = await pullPrepatchersFromServer(origin, local, serverPatchers(snapshot), serverPatchersOwnedBy(["GhostMod"], snapshot), { stagingRoot: staging });
    check("a dependency inside a differently-named folder is found and pulled", g.pulled, ["NeedsGhost.dll", "GhostPack"]);

    // What the server does not have either is SAID, not silently left.
    reset();
    const n = await pullPrepatchersFromServer(origin, local, serverPatchers(snapshot), [patcher("Lonely.dll", "file", lonely)], { stagingRoot: staging });
    check("a reference nothing provides is reported", n.unresolved, [{ patcher: "Lonely.dll", reference: "Nowhere" }]);

    // Asked for directly, SPT's own still is not pulled.
    reset();
    const spt = await pullPrepatchersFromServer(origin, local, serverPatchers(snapshot), [patcher("spt-prepatch.dll", "file")], { stagingRoot: staging });
    check("SPT's own prepatcher is refused even when asked for", [spt.pulled, fs.existsSync(path.join(local, "BepInEx", "patchers", "spt-prepatch.dll"))], [[], false]);

    state.folders = {};
    state.singles = {};
    state.companion = "1.2.0";
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
