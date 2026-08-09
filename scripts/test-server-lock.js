/**
 * "Lock to server" — matching the app's SPT version to the server you are about to join.
 *
 * The interesting case is not the happy one. It is locking to a server whose SPT differs from
 * the SPT actually installed here: the lock succeeds, and it fixes NOTHING. Matching the
 * catalogue does not make a 4.0.13 install able to join a 4.1.2 server, it only changes which
 * mods you are offered. If that were reported as plain success, someone would go and install a
 * whole set of mods that cannot work until they upgrade SPT itself.
 */
// Compiled on the fly with esbuild because the module lives under src/ — the button is in the
// renderer, which cannot import main-process code, so the logic has to live there too.
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const src = path.join(__dirname, "..", "src", "serverLock.ts");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-lock-")), "serverLock.js");
esbuild.buildSync({ entryPoints: [src], outfile: out, format: "cjs", platform: "node", bundle: false });
const { planSptVersionLock } = require(out);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== lock to server ===\n");

console.log("the ordinary case");
{
  const plan = planSptVersionLock({ serverVersion: "4.1.2", currentVersion: "4.0.13", instanceVersion: "4.1.2" });
  check("locks", plan.kind, "lock");
  check("to the server's version", plan.version, "4.1.2");
  check("remembering what it was", plan.previousVersion, "4.0.13");
  // The instance already matches the server; only the dropdown was off. Nothing to warn about.
  check("with no mismatch to report", plan.instanceMismatch, undefined);
}

console.log("\nlocking to a server this install cannot actually join");
{
  const plan = planSptVersionLock({ serverVersion: "4.1.2", currentVersion: "4.0.13", instanceVersion: "4.0.13" });
  check("still locks, because that is what was asked", plan.kind, "lock");
  check("to the server's version", plan.version, "4.1.2");
  // The whole point: the install is 4.0.13 and the server is 4.1.2. Locking changes the
  // catalogue, not the install.
  check("but reports the install it does not fix", plan.instanceMismatch, "4.0.13");
}

console.log("\nthe mismatch is judged against the INSTANCE, not the dropdown");
{
  // Someone has already overridden the dropdown to 4.1.2 while running a 4.0.13 install. The
  // override must not be able to hide the mismatch — that would make the warning disappear
  // exactly when it is most needed.
  const plan = planSptVersionLock({ serverVersion: "4.1.5", currentVersion: "4.1.2", instanceVersion: "4.0.13" });
  check("reports the real install", plan.instanceMismatch, "4.0.13");
  check("not the overridden value", plan.instanceMismatch === "4.1.2", false);
}

console.log("\npressing it when nothing would change");
{
  const plan = planSptVersionLock({ serverVersion: "4.1.2", currentVersion: "4.1.2", instanceVersion: "4.1.2" });
  check("is a no-op", plan.kind, "already-matching");
  check("and still names the version", plan.version, "4.1.2");
}

console.log("\na server that never said");
{
  const plan = planSptVersionLock({ serverVersion: undefined, currentVersion: "4.0.13", instanceVersion: "4.0.13" });
  check("cannot be locked to", plan.kind, "unavailable");
  check("and says why rather than silently doing nothing", /did not report an SPT version/.test(plan.reason), true);

  // Whitespace is not a version. Reached via a server that answered with an empty string.
  check("blank is treated the same", planSptVersionLock({ serverVersion: "   " }).kind, "unavailable");
}

console.log("\nnothing set locally yet");
{
  const plan = planSptVersionLock({ serverVersion: "4.1.2" });
  check("locks from empty", plan.kind, "lock");
  check("with no previous version invented", plan.previousVersion, undefined);
  check("and no mismatch claimed about an unknown install", plan.instanceMismatch, undefined);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
