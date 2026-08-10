/**
 * Builds the server companion and puts the result where the app packages it from.
 *
 * This exists because the copy used to be a manual step, and a manual step between "the source
 * changed" and "the shipped file changed" is a silent version skew waiting to happen — v1.4.0
 * nearly went out with a companion that was built but never packaged. Now there is one command,
 * and `electron-builder` reads exactly what it produces.
 *
 * The build itself needs an SPT install to reference: SPT does not publish its assemblies to a
 * feed, and the ones that matter are the ones the target server actually runs. Point SptDir
 * elsewhere to build against another version:
 *
 *   node scripts/build-companion.js "D:\\SPT41\\SPT_Runtime"
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const companion = path.join(root, "companion");
const outDir = path.join(companion, "dist");
const sptDir = process.argv[2];

const args = ["build", companion, "-c", "Release"];
if (sptDir) args.push(`-p:SptDir=${sptDir}`);

console.log(`Building the companion${sptDir ? ` against ${sptDir}` : ""}…`);
// No shell. `dotnet` is a real executable on every platform, and passing arguments through a
// shell would put an SPT path containing spaces at the mercy of quoting rules.
execFileSync("dotnet", args, { stdio: "inherit" });

const built = path.join(companion, "bin", "Release", "net9.0", "SptarkyCompanion.dll");
if (!fs.existsSync(built)) {
  console.error(`The build reported success but produced no DLL at ${built}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, "SptarkyCompanion.dll");
fs.copyFileSync(built, target);

// Printed rather than assumed. The failure this guards against is not a crash — it is a build
// that succeeds while shipping yesterday's DLL, which looks identical until someone runs it.
const { size, mtime } = fs.statSync(target);
console.log(`Packaged ${target} — ${size} bytes, built ${mtime.toISOString()}`);
