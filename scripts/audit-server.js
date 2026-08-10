/**
 * Compares a live SPT server against a local install, using the shipping code.
 *
 * Calls fetchServerSnapshot + buildServerSyncReport directly rather than reimplementing the
 * comparison, so what this prints is what the app decides. Read-only in both directions:
 * GET requests to the server, and a filesystem scan locally.
 *
 * Usage:
 *   npm run audit:server -- 192.168.1.78:6969 "D:\\SPT"
 */
const path = require("path");

const dist = path.join(__dirname, "..", "dist-electron");
const { scanMods, resolveSptInstance, detectSptSemver } = require(path.join(dist, "modManager.js"));
const { fetchServerSnapshot, buildServerSyncReport } = require(path.join(dist, "sptServer.js"));
const { loadAddonLedger } = require(path.join(dist, "addons.js"));

// The third argument mirrors the app's SPT version override. Without it this script sees
// only what detectSptSemver can read from disk, which is blank on installs where the user
// set the version by hand — and a blank local version silently disables the SPT match check.
const [serverArg, localArg, sptOverride] = process.argv.slice(2);
if (!serverArg || !localArg) {
  console.error('Usage: npm run audit:server -- <host:port> "<local SPT path>" [sptVersion]');
  process.exit(1);
}

(async () => {
  const resolved = resolveSptInstance(localArg);
  if (!resolved) {
    console.error(`No SPT instance at ${localArg}`);
    process.exit(1);
  }
  const { clientRoot, serverRoot } = resolved.instance;
  const localMods = scanMods(clientRoot, serverRoot);
  const localSpt = sptOverride || detectSptSemver(clientRoot);

  // The addon ledger, passed exactly as the app passes it. Addons mostly unpack into their
  // parent's folder, so this file is the only record they exist — reading it here is what keeps
  // the audit an honest reproduction of what the app decides rather than a subset of it.
  const localAddons = loadAddonLedger(clientRoot).map((a) => ({
    forgeAddonId: a.forgeAddonId,
    name: a.name,
    version: a.version,
    parentName: a.parentName
  }));

  const started = Date.now();
  const snapshot = await fetchServerSnapshot(serverArg);
  const report = buildServerSyncReport(snapshot, localMods, localSpt, localAddons);
  const elapsed = Date.now() - started;

  console.log("=".repeat(78));
  console.log("SERVER SYNC AUDIT");
  console.log("=".repeat(78));
  console.log(`  server : ${report.url}`);
  console.log(`  local  : ${serverRoot}`);

  if (!report.reachable) {
    console.log("");
    console.log(`  UNREACHABLE: ${report.error}`);
    process.exit(0);
  }

  console.log(`  SPT    : server ${report.sptVersion ?? "?"} / local ${report.localSptVersion ?? "?"}` +
    (report.sptMatches === false ? "   *** MISMATCH ***" : report.sptMatches ? "   (match)" : ""));
  console.log(`  fetched in ${elapsed}ms`);
  console.log("");

  const group = (issue) => report.rows.filter((r) => r.issue === issue);
  const show = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log("-".repeat(78));
    console.log(`${title}  (${rows.length})`);
    console.log("-".repeat(78));
    rows.forEach((r) => console.log(fmt(r)));
    console.log("");
  };

  // Which half each row came from. With a companion the list holds all three, and a client
  // plugin reported alongside server mods with no label reads as a server mod that failed.
  const side = (r) => (r.side && r.side !== "server" ? `[${r.side}] ` : "");

  show("INSTALL THESE — the server runs them, you do not", group("missing-locally"), (r) =>
    `  ${(side(r) + r.name).slice(0, 42).padEnd(42)} ${String(r.serverVersion ?? "?").padEnd(10)} ${r.author ?? ""}` +
    (r.installable === false ? `\n      BY HAND: ${r.notInstallableReason}` : "") +
    (r.url ? `\n      ${r.url}` : "")
  );
  show("UPDATE THESE — the server is newer", group("outdated-locally"), (r) =>
    `  ${(side(r) + r.name).slice(0, 42).padEnd(42)} ${String(r.localVersion).padStart(9)} -> ${String(r.serverVersion).padEnd(9)}` +
    (r.installable === false ? `\n      BY HAND: ${r.notInstallableReason}` : "") +
    (r.url ? `\n      ${r.url}` : "")
  );
  show("CANNOT COMPARE — no usable version on one side", group("unknown-local-version"), (r) =>
    `  ${(side(r) + r.name).slice(0, 42).padEnd(42)} local=${String(r.localVersion ?? "-").padEnd(10)} server=${r.serverVersion ?? "-"}`
  );
  show("NEWER HERE — you are ahead of the server", group("newer-locally"), (r) =>
    `  ${(side(r) + r.name).slice(0, 42).padEnd(42)} ${String(r.localVersion).padStart(9)} vs ${String(r.serverVersion).padEnd(9)} on server`
  );
  show("NOT ON THE SERVER — no effect in a raid there", group("not-on-server"), (r) =>
    `  ${(side(r) + r.name).slice(0, 42).padEnd(42)} ${String(r.localVersion ?? "-").padEnd(10)}`
  );

  const weak = report.rows.filter((r) => r.matchedBy === "name");
  if (weak.length) {
    console.log("-".repeat(78));
    console.log(`MATCHED BY NAME, NOT GUID  (${weak.length}) — weaker, worth an eye`);
    console.log("-".repeat(78));
    weak.forEach((r) => console.log(`  ${r.name}`));
    console.log("");
  }

  console.log("-".repeat(78));
  console.log("VERDICT");
  console.log("-".repeat(78));
  const c = report.counts;
  console.log(`  in sync         : ${c.inSync}`);
  console.log(`  need installing : ${c.needInstalling}`);
  console.log(`  need updating   : ${c.needUpdating}`);
  console.log(`  cannot compare  : ${c.unknownVersion}`);
  console.log(`  newer here      : ${c.newerLocally}`);
  console.log(`  not on server   : ${c.notOnServer}`);
  // Said out loud. "No addon differences" and "addons were not compared" produce identical
  // output otherwise, and they mean opposite things.
  console.log(`  addons compared : ${report.addonsCompared ? "yes" : "NO — one machine has no addon records"}`);
  console.log("");
  console.log(report.readyToPlay ? "  READY — server mods match." : "  NOT READY — resolve the items above.");

  if (report.fikaRequired.length || report.fikaOptional.length) {
    console.log("");
    console.log(`  Fika declares ${report.fikaRequired.length} required / ${report.fikaOptional.length} optional client plugin(s).`);
  } else {
    console.log("");
    console.log("  Fika declares no required client plugins (mods.required is empty in fika.jsonc),");
    console.log("  so client-side parity cannot be checked against this server.");
  }

  const withUrl = report.rows.filter((r) => r.url).length;
  console.log(`  server mods advertising a source URL: ${withUrl}/${snapshot.mods.length}`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
