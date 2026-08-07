/**
 * Updating the app from its own GitHub releases, with a chosen version.
 *
 * Windows will not let a running process replace its own .exe, so this cannot be a simple
 * overwrite. The sequence is:
 *
 *   1. download the release zip and check it is actually a zip that contains the app;
 *   2. extract it to a staging folder BESIDE the install;
 *   3. write a small .cmd that waits for this process to exit, moves the current install
 *      aside as a backup, moves staging into place, and relaunches;
 *   4. if anything in that fails, the script puts the backup back and relaunches that.
 *
 * Staging and backup live next to the install rather than in %TEMP% for one specific reason:
 * `move` cannot cross volumes. The app is typically installed on D: while %TEMP% is on C:,
 * so a temp-based staging folder would fail at the last step — after the current install had
 * already been moved aside. Keeping everything on one volume makes the swap a rename.
 */
import fs from "fs";
import path from "path";
import https from "https";
import { spawn } from "child_process";
import AdmZip from "adm-zip";

const RELEASES_API = "https://api.github.com/repos/cspicer5/SPTarky-Mod-Manager-Spicy/releases";

export interface AppRelease {
  tag: string;
  version: string;
  name: string;
  publishedAt?: string;
  notes?: string;
  assetUrl?: string;
  assetName?: string;
  assetSize?: number;
  prerelease: boolean;
  isCurrent: boolean;
}

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "SPTarky-Mod-Manager" }, timeout: 15000 },
      (res) => {
        // The releases API redirects in some cases; follow one hop rather than failing.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          getJson(res.headers.location).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (err: any) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timed out"));
    });
    req.end();
  });
}

/** Every published release, newest first, with the Windows zip asset located. */
export async function listAppReleases(currentVersion: string): Promise<{ releases: AppRelease[]; error?: string }> {
  try {
    const json = await getJson(`${RELEASES_API}?per_page=30`);
    if (!Array.isArray(json)) return { releases: [], error: "Unexpected response from GitHub." };

    const releases: AppRelease[] = json.map((r: any) => {
      const asset = (r.assets ?? []).find((a: any) => typeof a?.name === "string" && /win.*\.zip$/i.test(a.name));
      const version = String(r.tag_name ?? "").replace(/^v/i, "");
      return {
        tag: r.tag_name,
        version,
        name: r.name || r.tag_name,
        publishedAt: r.published_at,
        notes: typeof r.body === "string" ? r.body.slice(0, 4000) : undefined,
        assetUrl: asset?.browser_download_url,
        assetName: asset?.name,
        assetSize: asset?.size,
        prerelease: !!r.prerelease,
        isCurrent: version === currentVersion
      };
    });
    return { releases };
  } catch (err: any) {
    return { releases: [], error: err?.message ?? "Couldn't reach GitHub." };
  }
}

function download(url: string, dest: string, onProgress?: (received: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { "User-Agent": "SPTarky-Mod-Manager" }, timeout: 60000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading the release`));
        return;
      }
      const total = Number(res.headers["content-length"] ?? 0);
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (chunk) => {
        received += chunk.length;
        onProgress?.(received, total);
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("download timed out"));
    });
    req.end();
  });
}

export interface ApplyUpdateOptions {
  release: AppRelease;
  /** Directory the running executable lives in. */
  installDir: string;
  exeName: string;
  pid: number;
  onProgress?: (received: number, total: number) => void;
}

/**
 * Downloads and stages a release, then hands the swap to a detached script.
 *
 * Returns once the script is running; the caller is expected to quit immediately afterwards,
 * because the script is waiting for exactly that.
 */
export async function prepareUpdate(opts: ApplyUpdateOptions): Promise<{ success: boolean; message: string; script?: string }> {
  const { release, installDir, exeName, pid } = opts;
  if (!release.assetUrl) {
    return { success: false, message: `Release ${release.tag} has no Windows download attached.` };
  }

  const parent = path.dirname(installDir);
  const staging = path.join(parent, ".sptarky-update-staging");
  const backup = path.join(parent, ".sptarky-update-backup");
  const zipPath = path.join(parent, ".sptarky-update.zip");

  /*
   * Electron patches `fs` so that ANY path containing ".asar" is treated as an archive to
   * look inside, rather than as an ordinary file. Every release zip contains
   * `resources/app.asar`, so extracting one from inside the app made adm-zip write the file
   * and then fail to chmod it:
   *
   *   ENOENT: no such file or directory, chmod '...\.sptarky-update-staging\resources\app.asar'
   *
   * The same extraction succeeds in plain Node, which is exactly why this shipped: nothing
   * short of running it inside Electron could have caught it. `process.noAsar` turns the
   * interception off. It has to cover the cleanup paths too, since removing the staging
   * folder recurses through that same file.
   */
  const previousNoAsar = (process as NodeJS.Process & { noAsar?: boolean }).noAsar;
  (process as NodeJS.Process & { noAsar?: boolean }).noAsar = true;

  try {
    for (const leftover of [staging, backup]) {
      if (fs.existsSync(leftover)) fs.rmSync(leftover, { recursive: true, force: true });
    }

    await download(release.assetUrl, zipPath, opts.onProgress);

    // Verified BEFORE anything is moved. A truncated or wrong download that is only noticed
    // after the install has been renamed away is the one failure that leaves nothing to run.
    const stat = fs.statSync(zipPath);
    if (release.assetSize && Math.abs(stat.size - release.assetSize) > 1024) {
      throw new Error(`download is ${stat.size} bytes, expected ${release.assetSize} — treating it as incomplete`);
    }
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));
    const hasExe = entries.some((n) => n.toLowerCase().endsWith(exeName.toLowerCase()) || n.toLowerCase().endsWith(".exe"));
    if (!hasExe) throw new Error("that archive does not contain the application");

    fs.mkdirSync(staging, { recursive: true });
    zip.extractAllTo(staging, true);

    // Some zips wrap everything in a single top-level folder; unwrap it so the swap puts the
    // executable where it is expected rather than one level down.
    const top = fs.readdirSync(staging);
    if (top.length === 1) {
      const only = path.join(staging, top[0]);
      if (fs.statSync(only).isDirectory() && !fs.existsSync(path.join(staging, exeName))) {
        for (const entry of fs.readdirSync(only)) fs.renameSync(path.join(only, entry), path.join(staging, entry));
        fs.rmdirSync(only);
      }
    }
    if (!fs.existsSync(path.join(staging, exeName))) {
      throw new Error(`the archive does not contain ${exeName}`);
    }

    fs.rmSync(zipPath, { force: true });

    const script = path.join(parent, "sptarky-apply-update.cmd");
    fs.writeFileSync(script, buildSwapScript({ installDir, staging, backup, exeName, pid, script }), "utf-8");

    /*
     * Launched through a one-line VBScript shim so it is genuinely invisible.
     *
     * `windowsHide: true` cannot help here: `detached: true` gives the child its OWN console
     * on Windows, and that console is shown regardless. Users saw a black window appear as
     * the app closed and sit there — the update looked like a crash. WScript.Shell.Run with a
     * window style of 0 is the one way to start a console program on Windows with no window
     * at all, and `false` means do not wait, so the shim exits immediately.
     */
    const shim = path.join(parent, "sptarky-apply-update.vbs");
    fs.writeFileSync(
      shim,
      `CreateObject("WScript.Shell").Run "cmd /c ""${script}""", 0, False\r\n`,
      "utf-8"
    );

    const child = spawn("wscript.exe", ["//B", "//Nologo", shim], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    return { success: true, message: `Installing ${release.version}. The app will restart.`, script };
  } catch (err: any) {
    for (const leftover of [staging, zipPath]) {
      try {
        if (fs.existsSync(leftover)) fs.rmSync(leftover, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return { success: false, message: `Update failed: ${err?.message ?? err}. Your install was not touched.` };
  } finally {
    // Restored rather than left on: asar interception is what makes require() work against
    // the packaged app, and leaving it disabled would change behaviour well outside updating.
    (process as NodeJS.Process & { noAsar?: boolean }).noAsar = previousNoAsar;
  }
}

/**
 * The swap script.
 *
 * Every destructive step is checked, and any failure after the install has been moved aside
 * restores the backup and starts THAT — so the worst case is "you are still on the old
 * version", never "there is no app any more".
 */
export function buildSwapScript(o: {
  installDir: string;
  staging: string;
  backup: string;
  exeName: string;
  pid: number;
  script: string;
}): string {
  return `@echo off
setlocal
set "INSTALL=${o.installDir}"
set "STAGING=${o.staging}"
set "BACKUP=${o.backup}"
set "EXE=${o.exeName}"

rem Retry the MOVE rather than polling for the app process id.
rem The move fails exactly while the folder is locked and succeeds the moment it is not,
rem so it is a direct test of the thing we care about. Polling a pid meant piping tasklist
rem into find inside a detached console with no stdin, where find hung forever and left a
rem visible window while the update never happened. Ping is the sleep that ignores stdin.
rem Same volume, so a successful move is a rename and cannot half-finish.
rem
rem NOTE: keep these comments plain ASCII with no pipes, ampersands or angle brackets.
rem CMD parses redirection before rem swallows the line, so a pipe in a comment is still
rem executed. One in this very block split the line, left INSTALL empty, and broke the swap.
set /a TRIES=0
:wait
move "%INSTALL%" "%BACKUP%" >nul 2>&1
if not errorlevel 1 goto ready
set /a TRIES+=1
if %TRIES% GEQ 90 goto giveup
ping -n 2 127.0.0.1 >nul 2>&1
goto wait

:ready
move "%STAGING%" "%INSTALL%" >nul 2>&1
if errorlevel 1 goto rollback

if not exist "%INSTALL%\\%EXE%" goto rollback

start "" "%INSTALL%\\%EXE%"
rem Only remove the backup once the new version is in place and launching.
rd /s /q "%BACKUP%" >nul 2>&1
goto done

:rollback
if exist "%INSTALL%" rd /s /q "%INSTALL%" >nul 2>&1
move "%BACKUP%" "%INSTALL%" >nul 2>&1
start "" "%INSTALL%\\%EXE%"
goto done

:giveup
rem Never got the chance to touch anything; just start what is already there.
if exist "%INSTALL%\\%EXE%" start "" "%INSTALL%\\%EXE%"

:done
rd /s /q "%STAGING%" >nul 2>&1
rem The VBScript shim that launched this, removed alongside it.
del "%~dp0sptarky-apply-update.vbs" >nul 2>&1
del "%~f0" >nul 2>&1
`;
}
