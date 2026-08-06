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

    const child = spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true });
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

rem Wait for the app to exit. Without this the folder is still locked and every move fails.
set /a TRIES=0
:wait
tasklist /FI "PID eq ${o.pid}" 2>nul | find "${o.pid}" >nul
if errorlevel 1 goto ready
set /a TRIES+=1
if %TRIES% GEQ 60 goto giveup
timeout /t 1 /nobreak >nul
goto wait

:ready
rem Move rather than copy: same volume, so it is a rename and cannot half-finish.
move "%INSTALL%" "%BACKUP%" >nul 2>&1
if errorlevel 1 goto giveup

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
del "%~f0" >nul 2>&1
`;
}
