/**
 * Runs the update swap script against throwaway folders.
 *
 * This is the most destructive code in the app — it moves the install directory — so it is
 * exercised for real rather than reasoned about, including the rollback path. Everything
 * happens inside a temp directory; no actual install is involved.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { buildSwapScript } = require(path.join(__dirname, "..", "dist-electron", "selfUpdate.js"));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          expected ${expected}, got ${actual}`}`);
};

function scenario(name, { stagingHasExe }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-swap-"));
  const install = path.join(root, "app");
  const staging = path.join(root, ".sptarky-update-staging");
  const backup = path.join(root, ".sptarky-update-backup");
  const exeName = "App.cmd";

  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, exeName), "@echo off\r\nexit\r\n");
  fs.writeFileSync(path.join(install, "version.txt"), "OLD");
  fs.writeFileSync(path.join(install, "user-data.txt"), "keep me");

  fs.mkdirSync(staging, { recursive: true });
  if (stagingHasExe) fs.writeFileSync(path.join(staging, exeName), "@echo off\r\nexit\r\n");
  fs.writeFileSync(path.join(staging, "version.txt"), "NEW");

  const scriptPath = path.join(root, "apply.cmd");
  // PID 1 never matches a live process here, so the wait loop falls straight through —
  // exactly the state the script sees once the app has quit.
  fs.writeFileSync(scriptPath, buildSwapScript({ installDir: install, staging, backup, exeName, pid: 1, script: scriptPath }), "utf-8");

  console.log(`\n${name}`);
  try {
    execFileSync("cmd.exe", ["/c", scriptPath], { stdio: "ignore", timeout: 60000 });
  } catch {
    /* the script starts the "app" and deletes itself; a non-zero exit is not meaningful */
  }

  // The swap script relaunches the app with `start "" "<exe>"`, which is correct in
  // production. Here the "exe" is a dummy .cmd, and Windows opens .cmd files with /K — so
  // each run left a console window sitting open on a directory this test is about to
  // delete, showing "The system cannot find the path specified". Harmless but noisy, and
  // one leaked per test run. Closed by matching the temp directory in the command line.
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(root)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ],
      { stdio: "ignore", timeout: 20000 }
    );
  } catch {
    /* best effort — a leftover window must never fail the test */
  }

  const read = (f) => (fs.existsSync(path.join(install, f)) ? fs.readFileSync(path.join(install, f), "utf-8") : null);
  const result = {
    installExists: fs.existsSync(install),
    version: read("version.txt"),
    exePresent: fs.existsSync(path.join(install, exeName)),
    backupLeftBehind: fs.existsSync(backup),
    stagingLeftBehind: fs.existsSync(staging),
    scriptLeftBehind: fs.existsSync(scriptPath)
  };
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

const good = scenario("update applies cleanly", { stagingHasExe: true });
check("install directory still exists", good.installExists, true);
check("new version is in place", good.version, "NEW");
check("executable present", good.exePresent, true);
check("backup cleaned up on success", good.backupLeftBehind, false);
check("staging cleaned up", good.stagingLeftBehind, false);
check("script deletes itself", good.scriptLeftBehind, false);

// The safety net. If the swapped-in folder has no executable the app would be unlaunchable,
// so the script must put the old one back rather than leave an empty install.
const bad = scenario("rollback when the new version has no executable", { stagingHasExe: false });
check("install directory still exists", bad.installExists, true);
check("rolled back to the old version", bad.version, "OLD");
check("old executable restored", bad.exePresent, true);
check("backup consumed by the rollback", bad.backupLeftBehind, false);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
