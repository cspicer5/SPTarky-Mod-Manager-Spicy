/**
 * Which SPT version an install IS.
 *
 * This number decides which builds an update check resolves, what browse filters to, and whether
 * a mod is called compatible. It failed SILENTLY on every SPT 4.x install for months: 4.x stopped
 * putting `sptVersion` in core.json, the reader only looked there, and the app fell back to
 * whatever was last stored — so switching from a 4.0 install to a 4.1 one appeared to change
 * nothing at all.
 *
 * Two traps live here, and both are why this is read from a file rather than a config:
 *
 *   - SPT.Server.EXE is a .NET apphost: a native launcher with Win32 version resources but no
 *     CLI metadata. A metadata reader gets nothing from it. The assembly attributes are in
 *     SPT.Server.DLL beside it.
 *   - AssemblyInformationalVersion is "4.0.13-RELEASE+2891fd4.…", which no catalogue can be
 *     filtered by. AssemblyFileVersion is the plain "4.0.13".
 *
 * Runs against real installs when they are present and says so when they are not, rather than
 * passing vacuously — a detection test that skips silently is worse than none.
 */
const fs = require("fs");
const path = require("path");
const { detectSptSemver } = require(path.join(__dirname, "..", "dist-electron", "modManager.js"));
const { readAssemblyVersionStrings } = require(path.join(__dirname, "..", "dist-electron", "peMetadata.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`
  );
};

console.log("\n=== detecting an install's SPT version ===\n");

/*
 * Real installs, when this machine has them. Deliberately not mocked: the failure being guarded
 * against is "the file no longer says what we think it says", which a fixture cannot catch —
 * a fixture would simply keep asserting the old shape forever.
 */
const REAL = [
  { path: "D:\\SPT", line: "4.0", label: "a 4.0 install" },
  { path: "D:\\SPT41", line: "4.1", label: "a 4.1 install (server in SPT_Runtime/)" }
];

/**
 * The LINE plus the shape, rather than an exact build.
 *
 * These are live installs that get updated underneath this test. Pinning "4.1.2" meant an SPT
 * upgrade to 4.1.5 failed a check that was reporting the truth — the detection was right and the
 * expectation was stale, which is the kind of failure that teaches people to ignore a suite.
 *
 * What must still hold is everything that has actually broken here before. undefined is the
 * apphost trap (metadata read from SPT.Server.exe, which carries none) and a qualifier is the
 * informational-version trap ("4.1.5-RELEASE+7d7add5"), which is useless for catalogue
 * filtering. Requiring a plain three-part number on the expected line catches both.
 */
const plainLine = (v) =>
  typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").slice(0, 2).join(".") : v;

let checkedAny = false;
console.log("real installs on this machine");
for (const { path: root, line, label } of REAL) {
  if (!fs.existsSync(root)) {
    console.log(`  SKIP  ${label} — ${root} is not on this machine`);
    continue;
  }
  checkedAny = true;
  // From the CLIENT root, which is what the app stores and passes. 4.1 keeps the server in a
  // subfolder, so this only works if the search looks down rather than assuming a layout.
  const detected = detectSptSemver(root);
  check(`${label}: detected from the client root (saw ${JSON.stringify(detected)})`, plainLine(detected), line);
}
if (!checkedAny) console.log("  (no reference installs here — the checks below still apply)");

console.log("\nthe apphost trap");
{
  const exe = "D:\\SPT\\SPT\\SPT.Server.exe";
  const dll = "D:\\SPT\\SPT\\SPT.Server.dll";
  if (fs.existsSync(exe) && fs.existsSync(dll)) {
    // The exe is a native launcher: no CLI metadata, so a metadata reader must come back empty.
    // This is the whole reason the .dll is read instead, and it is worth pinning — if a future
    // SPT ships a single-file exe WITH metadata, this flips and the fallback should be revisited.
    check("the exe carries no assembly metadata", readAssemblyVersionStrings(fs.readFileSync(exe)), null);
    const fromDll = readAssemblyVersionStrings(fs.readFileSync(dll));
    check("the dll does", Boolean(fromDll), true);
    check("and its file version is a plain number", fromDll.file, "4.0.13");
    // ...whereas informational is not something a catalogue can be filtered by.
    check("while informational carries a qualifier", /-RELEASE\+/.test(fromDll.informational), true);
  } else {
    console.log("  SKIP  D:\\SPT is not on this machine");
  }
}

console.log("\nwhen there is nothing to read");
{
  check("a path that does not exist yields nothing", detectSptSemver("D:\\definitely-not-an-spt-install"), undefined);
  // Never a guess: an unknown version has to stay unknown, because every consumer treats a
  // version as fact and would answer confidently for an install it knows nothing about.
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "sptarky-detect-"));
  check("an empty folder yields nothing", detectSptSemver(tmp), undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`
${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
