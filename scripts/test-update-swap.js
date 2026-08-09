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
  // The pid is no longer consulted at all: the script retries the MOVE, which fails exactly
  // while the folder is locked. Polling a pid meant hanging inside `tasklist | find` in a
  // detached console with no stdin, leaving a visible window and never updating anything.
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

console.log("\nthe script uses nothing that can hang on a missing stdin");
{
  // Every one of these ran in a detached console with no stdin. `tasklist | find` hung inside
  // find, leaving a window titled 'find "12604"' that had to be killed by hand while the
  // update silently never happened. `timeout` refuses redirected input for the same reason.
  const body = buildSwapScript({
    installDir: "C:\\i",
    staging: "C:\\s",
    backup: "C:\\b",
    exeName: "app.exe",
    pid: 4080,
    script: "C:\\x.cmd"
  });
  /*
   * CMD parses redirection and pipes BEFORE `rem` swallows the line, so a pipe inside a
   * comment is still executed. One in this script's own comments split the line, left
   * INSTALL empty, and turned every move into `move "" ""` — the script ran to completion
   * and updated nothing. Non-ASCII is checked too: a .cmd is read in the console codepage.
   */
  const offending = body
    .split(/\r?\n/)
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /^\s*rem\b/i.test(line))
    .filter(({ line }) => /[|&<>]/.test(line) || /[^\x00-\x7F]/.test(line));
  check(
    "no comment contains a pipe, redirect or non-ASCII character",
    offending.length === 0 ? "clean" : offending.map((o) => `line ${o.i}`).join(", "),
    "clean"
  );

  // Only the lines cmd will RUN. The comments name these utilities to explain why they are
  // gone, and matching those was the assertion failing rather than the script.
  const code = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*rem\b/i.test(line))
    .join("\n");
  check("no tasklist", /tasklist/i.test(code), false);
  check("no find", /\bfind\b/i.test(code), false);
  check("no timeout", /\btimeout\b/i.test(code), false);
  check("sleeps with ping, which ignores stdin", /ping -n/i.test(code), true);
  // The pid is no longer consulted: whether the move succeeds IS whether the app let go.
  check("does not mention the pid at all", body.includes("4080"), false);
  check("retries the move instead", /:wait[\s\S]*move "%INSTALL%" "%BACKUP%"/.test(body), true);
  check("and removes its own launcher shim", /sptarky-apply-update\.vbs/.test(body), true);
}

const good = scenario("update applies cleanly", { stagingHasExe: true });
check("install directory still exists", good.installExists, true);
check("new version is in place", good.version, "NEW");
check("executable present", good.exePresent, true);
check("backup cleaned up on success", good.backupLeftBehind, false);
check("staging cleaned up", good.stagingLeftBehind, false);
check("script deletes itself", good.scriptLeftBehind, false);

/*
 * A genuinely locked folder — the case that was never covered, and the one that broke.
 *
 * Every earlier scenario ran against a folder nothing held open, so the script's wait was
 * never exercised at all. In production the app IS holding it, and the update silently did
 * nothing while a console window sat there spinning. Here a process holds a handle inside the
 * install and releases it partway through; the script must wait it out and then complete.
 */
{
  const { spawn } = require("child_process");
  const exeName = "fake-app.cmd";
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-swap-lock-"));
  const install2 = path.join(root2, "app");
  const staging2 = path.join(root2, ".staging");
  fs.mkdirSync(install2, { recursive: true });
  fs.writeFileSync(path.join(install2, exeName), "@echo off\r\nexit /b 0\r\n");
  fs.writeFileSync(path.join(install2, "version.txt"), "OLD");
  fs.mkdirSync(staging2, { recursive: true });
  fs.writeFileSync(path.join(staging2, exeName), "@echo off\r\nexit /b 0\r\n");
  fs.writeFileSync(path.join(staging2, "version.txt"), "NEW");

  const script2 = path.join(root2, "apply.cmd");
  fs.writeFileSync(
    script2,
    buildSwapScript({
      installDir: install2,
      staging: staging2,
      backup: path.join(root2, ".backup"),
      exeName,
      pid: 999999,
      script: script2
    }),
    "utf-8"
  );

  const locker = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$f=[System.IO.File]::Open('${path.join(install2, "version.txt")}','Open','Read','None'); Start-Sleep -Seconds 6; $f.Close()`
    ],
    { stdio: "ignore" }
  );

  console.log("\nthe folder is genuinely locked when the script starts");
  // PowerShell takes about a second to start, and without waiting for it the swap ran before
  // the lock existed — the test then "passed" while proving nothing.
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 1800"], {
      stdio: "ignore",
      timeout: 20000
    });
  } catch {
    /* best effort */
  }
  const started = Date.now();
  try {
    execFileSync("cmd.exe", ["/c", script2], { stdio: "ignore", timeout: 120000 });
  } catch {
    /* the script relaunches the dummy app; a non-zero exit is not meaningful */
  }
  const waited = (Date.now() - started) / 1000;

  const finalVersion = fs.existsSync(path.join(install2, "version.txt"))
    ? fs.readFileSync(path.join(install2, "version.txt"), "utf-8")
    : "(gone)";
  check("it waited rather than giving up immediately", waited > 3, true);
  check("and the swap completed", finalVersion, "NEW");
  check("staging cleaned up", fs.existsSync(staging2), false);

  try {
    locker.kill();
  } catch {
    /* already gone */
  }
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(root2)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ],
      { stdio: "ignore", timeout: 20000 }
    );
  } catch {
    /* best effort */
  }
  fs.rmSync(root2, { recursive: true, force: true });
}

/*
 * The script is STARTED FROM INSIDE the folder it has to move.
 *
 * This is what actually broke a real update, and it is a different lock from the one above:
 * not an open file handle, but the working directory itself. Windows will not move a
 * directory that is any process's cwd — "The process cannot access the file because it is
 * being used by another process" — and spawn() hands a child the parent's cwd, which for an
 * app launched from Explorer is its own exe folder. So the script stood inside the folder it
 * was moving, retried 90 times, gave up, deleted itself and relaunched the OLD version.
 *
 * Every other scenario in this file runs the script from a neutral directory, which is
 * precisely why they all passed while the real thing failed. The fix is `cd /d "%~dp0"` as
 * the script's first act; this proves it works by reproducing the exact condition.
 */
{
  const exeName = "fake-app.cmd";
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "sptarky-swap-cwd-"));
  const install3 = path.join(root3, "app");
  const staging3 = path.join(root3, ".staging");
  fs.mkdirSync(install3, { recursive: true });
  fs.writeFileSync(path.join(install3, exeName), "@echo off\r\nexit /b 0\r\n");
  fs.writeFileSync(path.join(install3, "version.txt"), "OLD");
  fs.mkdirSync(staging3, { recursive: true });
  fs.writeFileSync(path.join(staging3, exeName), "@echo off\r\nexit /b 0\r\n");
  fs.writeFileSync(path.join(staging3, "version.txt"), "NEW");

  const script3 = path.join(root3, "apply.cmd");
  fs.writeFileSync(
    script3,
    buildSwapScript({
      installDir: install3,
      staging: staging3,
      backup: path.join(root3, ".backup"),
      exeName,
      pid: 1,
      script: script3
    }),
    "utf-8"
  );

  console.log("\nthe script is launched from inside the install folder");
  try {
    // cwd IS the install directory — exactly what the app passed on before the fix.
    execFileSync("cmd.exe", ["/c", script3], { stdio: "ignore", timeout: 120000, cwd: install3 });
  } catch {
    /* the script relaunches the dummy app; a non-zero exit is not meaningful */
  }

  const version3 = fs.existsSync(path.join(install3, "version.txt"))
    ? fs.readFileSync(path.join(install3, "version.txt"), "utf-8")
    : "(gone)";
  check("the swap still completed", version3, "NEW");
  check("the executable is present", fs.existsSync(path.join(install3, exeName)), true);
  check("staging cleaned up", fs.existsSync(staging3), false);
  // The log is the other half of the fix: three failures were diagnosed blind for want of it.
  check("a log was written", fs.existsSync(path.join(root3, "sptarky-update.log")), true);

  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(root3)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ],
      { stdio: "ignore", timeout: 20000 }
    );
  } catch {
    /* best effort */
  }
  fs.rmSync(root3, { recursive: true, force: true });
}

// The safety net. If the swapped-in folder has no executable the app would be unlaunchable,
// so the script must put the old one back rather than leave an empty install.
const bad = scenario("rollback when the new version has no executable", { stagingHasExe: false });
check("install directory still exists", bad.installExists, true);
check("rolled back to the old version", bad.version, "OLD");
check("old executable restored", bad.exePresent, true);
check("backup consumed by the rollback", bad.backupLeftBehind, false);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
