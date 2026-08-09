/**
 * Bundle sync.
 *
 * This is the second most destructive thing the app does — it WRITES into the game's bundle
 * cache using paths chosen by a remote server — so it is exercised against a real HTTP server
 * rather than reasoned about. A stub, not the live one: what is being tested is the client's
 * behaviour, and a suite that needed a game server running would fail for reasons that are
 * not this code's fault.
 *
 * The cases that matter most are the ones a naive implementation gets wrong:
 *
 *   - FileName comes from the SERVER and becomes a path that is written to. `../` must not
 *     escape the cache.
 *   - 24 of the reference server's 3,160 bundles have SPACES in their path, and Node's http
 *     client throws on an unescaped path rather than failing the request.
 *   - A bundle whose content changed keeps its path, so existence proves nothing. Only the
 *     CRC does.
 *   - A truncated download must never land where a valid bundle belongs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");

const B = require(path.join(__dirname, "..", "dist-electron", "bundles.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-bundles-"));
const cache = path.join(root, "user", "cache", "bundles");
fs.mkdirSync(cache, { recursive: true });

/* --------------------------------------------------------------- path safety */
console.log("\n=== bundle sync ===\n");
console.log("a server-supplied path may not escape the cache");
{
  const inside = (p) => B.safeLocalPath(cache, p) !== null;
  check("an ordinary path is accepted", inside("assets/content/x.bundle"), true);
  check("a nested path is accepted", inside("a/b/c/d.bundle"), true);
  check("../ is refused", inside("../evil.bundle"), false);
  check("../ buried mid-path is refused", inside("assets/../../../evil.bundle"), false);
  check("an absolute path is refused", inside("/etc/passwd"), false);
  check("a drive letter is refused", inside("C:/Windows/System32/x.dll"), false);
  check("a backslash drive letter is refused", inside("C:\\Windows\\x.dll"), false);
  check("empty is refused", inside(""), false);
  // A sibling folder whose name merely starts with the cache's name is NOT inside it; a
  // plain string-prefix test would accept it.
  check("a same-prefix sibling directory is refused", inside("../bundles-evil/x.bundle"), false);
}

console.log("\nurl encoding (24 real bundles have spaces; Node throws on an unescaped path)");
{
  check("a space becomes %20", B.encodeBundlePath("mods/pistol grips/x.bundle"), "mods/pistol%20grips/x.bundle");
  check("slashes are preserved", B.encodeBundlePath("a/b/c.bundle"), "a/b/c.bundle");
  // encodeURI would leave these, and they would truncate the path or start a query string.
  check("# is encoded", B.encodeBundlePath("a/b#c.bundle"), "a/b%23c.bundle");
  check("? is encoded", B.encodeBundlePath("a/b?c.bundle"), "a/b%3Fc.bundle");
  check("& is encoded", B.encodeBundlePath("a/b&c.bundle"), "a/b%26c.bundle");
}

/* ------------------------------------------------------------- a stub server */
const BUNDLES = {
  "assets/a.bundle": Buffer.from("first bundle payload"),
  "assets/pistol grips/b.bundle": Buffer.from("a path with a space in it"),
  "assets/c.bundle": Buffer.from("third")
};
const manifest = Object.entries(BUNDLES).map(([fileName, buf], i) => ({
  ModPath: `user/mods/Test${i}`,
  FileName: fileName,
  Bundle: { key: fileName, dependencyKeys: [] },
  Crc: zlib.crc32(buf),
  Dependencies: []
}));

let serveTruncated = false;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/singleplayer/bundles") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manifest));
    return;
  }
  const prefix = "/files/bundle/";
  if (url.startsWith(prefix)) {
    const key = url.slice(prefix.length);
    const buf = BUNDLES[key];
    if (!buf) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(serveTruncated ? buf.subarray(0, 2) : buf);
    return;
  }
  res.writeHead(404);
  res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log("\nreading the manifest");
  const entries = await B.fetchBundleManifest(base);
  check("every bundle is listed", entries.length, 3);
  check("the crc comes through", entries[0].crc, manifest[0].Crc);
  check("the mod path comes through", entries[0].modPath, "user/mods/Test0");

  console.log("\nplanning against an empty cache");
  {
    const plan = B.planBundleSync(entries, cache);
    check("everything is missing", plan.missing.length, 3);
    check("nothing is ok", plan.ok.length, 0);
    check("nothing is orphaned", plan.orphans.length, 0);
    check("and it says so", B.describeBundlePlan(plan), "3 missing of 3 server bundle(s).");
  }

  console.log("\ndownloading");
  {
    const { results } = await B.syncBundles(base, entries, cache, { concurrency: 2 });
    check("all three arrive", results.filter((r) => r.ok).length, 3);
    // The one with a space is the whole reason encoding is per-segment.
    const spacey = results.find((r) => r.fileName.includes(" "));
    check("including the one with a space in its path", spacey.ok, true);
    check("bytes are written", fs.readFileSync(path.join(cache, "assets", "a.bundle"), "utf8"), "first bundle payload");
    check("no .part files are left", B.listLocalBundles(cache).filter((f) => f.endsWith(".part")).length, 0);
  }

  console.log("\nplanning again once they are present");
  {
    const plan = B.planBundleSync(entries, cache);
    check("all present and matching", plan.ok.length, 3);
    check("nothing missing", plan.missing.length, 0);
    check("nothing stale", plan.stale.length, 0);
    check("and it says so", B.describeBundlePlan(plan), "All 3 of the server's bundles are present and match.");
  }

  console.log("\na bundle whose CONTENT changed keeps its path");
  {
    // Existence would call this fine. Only the CRC notices.
    fs.writeFileSync(path.join(cache, "assets", "a.bundle"), "tampered or out of date");
    const plan = B.planBundleSync(entries, cache);
    check("it is stale, not ok", plan.stale.length, 1);
    check("and not counted as missing", plan.missing.length, 0);
    check("the local crc is reported", typeof plan.stale[0].localCrc, "number");
    check("summary names it", B.describeBundlePlan(plan), "1 out of date of 3 server bundle(s).");

    const { results } = await B.syncBundles(base, [plan.stale[0].entry], cache);
    check("re-downloading repairs it", results[0].ok, true);
    check("and it verifies afterwards", B.planBundleSync(entries, cache).ok.length, 3);
  }

  console.log("\nlocal files the server does not list");
  {
    const orphan = path.join(cache, "assets", "left-over.bundle");
    fs.writeFileSync(orphan, "from a mod that is gone");
    const plan = B.planBundleSync(entries, cache);
    check("it is reported as an orphan", plan.orphans.length, 1);
    check("with its size", plan.orphanBytes, fs.statSync(orphan).size);
    // Never deleted: the user may be about to reinstall the mod, and re-downloading is the
    // expensive direction. The reference install has 85 of these, 377 MB.
    check("and is NOT deleted", fs.existsSync(orphan), true);
    check("and does not make the plan look dirty", plan.missing.length + plan.stale.length, 0);
    fs.rmSync(orphan);
  }

  console.log("\na truncated download never lands");
  {
    serveTruncated = true;
    const target = path.join(cache, "assets", "c.bundle");
    const before = fs.readFileSync(target);
    const entry = entries.find((e) => e.fileName === "assets/c.bundle");
    const { results } = await B.syncBundles(base, [entry], cache);
    check("it fails", results[0].ok, false);
    check("because the checksum does not match", /checksum mismatch/.test(results[0].message ?? ""), true);
    check("the good file is untouched", fs.readFileSync(target).equals(before), true);
    check("and no .part is left behind", B.listLocalBundles(cache).filter((f) => f.endsWith(".part")).length, 0);
    serveTruncated = false;
  }

  console.log("\nrefusing a hostile manifest");
  {
    const evil = [{ modPath: "x", fileName: "../../escaped.bundle", crc: 1, dependencies: [] }];
    const { results } = await B.syncBundles(base, evil, cache);
    check("the download is refused", results[0].ok, false);
    check("with a reason", /outside the cache/.test(results[0].message ?? ""), true);
    check("and nothing is written above the cache", fs.existsSync(path.join(root, "user", "cache", "escaped.bundle")), false);
  }

  console.log("\ncancelling mid-run");
  {
    const many = entries.concat(entries).concat(entries);
    let seen = 0;
    const { cancelled } = await B.syncBundles(base, many, cache, {
      concurrency: 1,
      shouldCancel: () => ++seen > 2
    });
    check("it stops and says so", cancelled, true);
  }

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
