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
const { listServerModFiles, installModFromServer } = require(path.join(__dirname, "..", "dist-electron", "serverFiles.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

/** Files the stub will serve, and how it should misbehave. */
const state = { files: {}, truncate: null, fail: null, listError: null, extraPath: null };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url ?? "");
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

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
