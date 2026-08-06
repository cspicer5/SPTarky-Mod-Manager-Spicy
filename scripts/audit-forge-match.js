/**
 * Forge match audit.
 *
 * Runs the REAL matching code (scanMods + matchForgeMods from the compiled backend)
 * against an SPT install and reports what resolved, how, and what did not. This is the
 * measurement behind claims like "the match rate went up" — without it, those are
 * predictions rather than results.
 *
 * Usage:
 *   npm run build                                  # the audit uses dist-electron/
 *   node scripts/audit-forge-match.js "D:\\SPT - Test"
 *   node scripts/audit-forge-match.js "D:\\SPT - Test" --write
 *
 * By default nothing is WRITTEN to the install, but the existing cache is still READ — so
 * the audit reports what the app would actually resolve. Pass --write to persist newly
 * confirmed matches as well.
 *
 * Those used to be one switch, and read-only mode dropped the cache entirely. The audit
 * then re-guessed every mod from scratch and reported five manual pins on D:\SPT41 as
 * unconfirmed, including fika-server as "Fika Headless Launcher" — a mod the user had
 * already pinned to Project Fika - Server. The app was right; the audit was measuring a
 * path the app does not take.
 */
const path = require("path");
const fs = require("fs");

const backend = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));

const args = process.argv.slice(2);
const write = args.includes("--write");
const root = args.find((a) => !a.startsWith("--"));

if (!root) {
  console.error("Usage: node scripts/audit-forge-match.js <path-to-SPT-install> [--write]");
  process.exit(1);
}

function main() {
  const resolved = backend.resolveSptInstance(root);
  if (!resolved) {
    console.error(`Not a recognisable SPT instance: ${root}`);
    process.exit(1);
  }
  const { clientRoot, serverRoot, split } = resolved.instance;

  console.log("=".repeat(78));
  console.log("FORGE MATCH AUDIT");
  console.log("=".repeat(78));
  console.log(`install     : ${root}`);
  console.log(`clientRoot  : ${clientRoot}`);
  console.log(`serverRoot  : ${serverRoot}${split ? "  (SPLIT INSTALL)" : ""}`);
  console.log(`cache read  : enabled (manual pins are honoured)`);
  console.log(`cache write : ${write ? "ENABLED (--write)" : "disabled (read-only)"}`);

  // What the previous version left behind, so we can show what changed.
  const cacheFile = path.join(clientRoot, ".spt-mod-manager-forge-match.json");
  let priorCache = null;
  if (fs.existsSync(cacheFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      priorCache = parsed;
      const version = parsed.version ?? 1;
      const count = version === 1 ? Object.keys(parsed).length : Object.keys(parsed.entries ?? {}).length;
      console.log(`prior cache : v${version}, ${count} entries` + (version === 1 ? "  <- will be DISCARDED (no provenance)" : ""));
    } catch {
      console.log("prior cache : present but unreadable");
    }
  } else {
    console.log("prior cache : none");
  }

  const mods = backend.scanMods(clientRoot, serverRoot);
  console.log(`scanned     : ${mods.length} mods ` + `(${mods.filter((m) => m.type === "server").length} server, ` + `${mods.filter((m) => m.type === "client").length} client, ` + `${mods.filter((m) => m.type === "hybrid").length} hybrid)`);
  console.log(`with a GUID : ${mods.filter((m) => m.guid).length}`);
  console.log("");

  let lastPct = -1;
  const onProgress = (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      process.stdout.write(`  resolving... ${done}/${total}\r`);
      lastPct = pct;
    }
  };

  const started = Date.now();
  backend
    .matchForgeMods(backend.buildForgeMatchInput(mods), onProgress, clientRoot, { writeCache: write })
    .then((matches) => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(" ".repeat(40) + "\r");

      const notChecked = matches.notChecked ?? new Set();
      const byMethod = {};
      const rows = [];

      for (const mod of mods) {
        const m = matches.get(mod.originalName);
        if (m) {
          byMethod[m.method] = (byMethod[m.method] ?? 0) + 1;
          rows.push({ mod, match: m });
        } else {
          const why = notChecked.has(mod.originalName) ? "not-checked" : "no-match";
          byMethod[why] = (byMethod[why] ?? 0) + 1;
          rows.push({ mod, match: null, why });
        }
      }

      console.log("-".repeat(78));
      console.log("RESULTS");
      console.log("-".repeat(78));
      for (const r of rows) {
        if (r.match) {
          const flag = r.match.needsConfirmation ? " [NEEDS CONFIRMATION]" : "";
          console.log(
            `  ${r.match.method.padEnd(10)} ${(r.mod.type + ":" + r.mod.originalName).padEnd(46)} -> [${String(r.match.modId).padStart(4)}] ${r.match.forgeName ?? "?"}${flag}`
          );
        } else {
          console.log(`  ${r.why.padEnd(10)} ${(r.mod.type + ":" + r.mod.originalName).padEnd(46)} -> —`);
        }
      }

      const matched = rows.filter((r) => r.match).length;
      const confident = rows.filter((r) => r.match && !r.match.needsConfirmation).length;
      const needsConfirm = rows.filter((r) => r.match && r.match.needsConfirmation).length;

      console.log("");
      console.log("-".repeat(78));
      console.log("SUMMARY");
      console.log("-".repeat(78));
      console.log(`  elapsed            : ${elapsed}s`);
      console.log(`  total mods         : ${mods.length}`);
      console.log(`  matched            : ${matched}  (${((100 * matched) / mods.length).toFixed(1)}%)`);
      console.log(`    of which trusted : ${confident}  (${((100 * confident) / mods.length).toFixed(1)}%)`);
      console.log(`    needs confirming : ${needsConfirm}`);
      console.log(`  unmatched          : ${mods.length - matched}`);
      console.log("");
      console.log("  by method:");
      for (const [k, v] of Object.entries(byMethod).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${k.padEnd(12)} ${v}`);
      }

      // Compare against the old cache, where one existed, to surface changed mappings.
      if (priorCache && (priorCache.version ?? 1) === 1) {
        const changed = [];
        for (const r of rows) {
          const old = priorCache[r.mod.originalName];
          if (old && r.match && String(r.match.modId) !== String(old)) {
            changed.push({ name: r.mod.originalName, from: old, to: r.match.modId, forgeName: r.match.forgeName });
          }
        }
        if (changed.length) {
          console.log("");
          console.log("  mappings CHANGED vs the old v1 cache (old value was wrong or unverifiable):");
          for (const c of changed) {
            console.log(`    ${c.name.padEnd(44)} ${c.from} -> ${c.to}  (${c.forgeName})`);
          }
        }
      }
      console.log("");
    })
    .catch((err) => {
      console.error("AUDIT FAILED:", err);
      process.exit(1);
    });
}

main();
