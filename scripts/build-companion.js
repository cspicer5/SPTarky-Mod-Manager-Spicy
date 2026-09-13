/**
 * Builds the server companion and puts the results where the app packages them from.
 *
 * This exists because the copy used to be a manual step, and a manual step between "the source
 * changed" and "the shipped file changed" is a silent version skew waiting to happen — v1.4.0
 * nearly went out with a companion that was built but never packaged. Now there is one command,
 * and `electron-builder` reads exactly what it produces.
 *
 * TWO builds come out, not one. SPT 4.0.x servers run on .NET 9 and 4.1.x on .NET 10, and a net10
 * assembly cannot be loaded by a net9 runtime at all — so one DLL genuinely cannot serve both.
 * They land in `companion/dist/spt4.0/` and `companion/dist/spt4.1/`, and the installer picks by
 * the SPT version it detected on the instance.
 *
 * The build needs an SPT install of EACH line to reference: SPT does not publish its assemblies
 * to a feed, and the ones that matter are the ones the target server actually runs. Both default
 * to this machine's installs and both are overridable:
 *
 *   node scripts/build-companion.js --spt40 "D:\SPT\SPT" --spt41 "D:\SPT41\SPT_Runtime"
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const companion = path.join(root, "companion");
const outDir = path.join(companion, "dist");

/**
 * Each framework paired with the SPT line it is for. The folder name is the SPT line rather than
 * the framework, because that is the question the installer is answering — nothing downstream
 * should have to know which .NET version SPT happened to move to.
 */
const TARGETS = [
  { tfm: "net9.0", line: "spt4.0", prop: "SptDir40", flag: "--spt40" },
  { tfm: "net10.0", line: "spt4.1", prop: "SptDir41", flag: "--spt41" }
];

function argFor(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const args = ["build", companion, "-c", "Release"];
for (const t of TARGETS) {
  const dir = argFor(t.flag);
  if (dir) args.push(`-p:${t.prop}=${dir}`);
}

console.log("Building the companion for SPT 4.0 (net9.0) and SPT 4.1 (net10.0)…");
// No shell. `dotnet` is a real executable on every platform, and passing arguments through a
// shell would put an SPT path containing spaces at the mercy of quoting rules.
execFileSync("dotnet", args, { stdio: "inherit" });

fs.mkdirSync(outDir, { recursive: true });
for (const t of TARGETS) {
  const built = path.join(companion, "bin", "Release", t.tfm, "SptarkyCompanion.dll");
  if (!fs.existsSync(built)) {
    console.error(`The build reported success but produced no ${t.tfm} DLL at ${built}`);
    process.exit(1);
  }
  const dir = path.join(outDir, t.line);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "SptarkyCompanion.dll");
  fs.copyFileSync(built, target);

  // Printed rather than assumed. The failure this guards against is not a crash — it is a build
  // that succeeds while shipping yesterday's DLL, which looks identical until someone runs it.
  const { size, mtime } = fs.statSync(target);
  console.log(`Packaged ${target} — ${size} bytes, built ${mtime.toISOString()}`);
}

// The two must not be the same file. They are compiled against different SPT assemblies and for
// different runtimes, so identical bytes means one of them was copied from the wrong place.
const [a, b] = TARGETS.map((t) => fs.readFileSync(path.join(outDir, t.line, "SptarkyCompanion.dll")));
if (a.equals(b)) {
  console.error("Both builds produced byte-identical DLLs — one of them is not what it claims.");
  process.exit(1);
}
