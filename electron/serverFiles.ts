/**
 * Installing a mod from the SERVER you are joining, rather than from the catalogue.
 *
 * The companion has served files since v1.4.0 and nothing ever called those routes; this is the
 * half that was missing. It matters because the catalogue answers a different question from the
 * one being asked. "Match server" wants the bytes that machine is running — not the newest
 * release, not the newest release built for this SPT, but THAT build. Those are frequently three
 * different things, and the difference is exactly what desyncs a raid.
 *
 * It also covers mods the catalogue cannot answer for at all: a private build, a mod pulled from
 * the catalogue since, one installed by hand on the host, or one whose entry never carried a
 * download link.
 *
 * ## What arrives, and what is checked
 *
 * `/sptarky/filelist/{half}/{mod}` lists every file with its size; `/sptarky/filedata/{half}/{mod}/{rel}`
 * returns one file's bytes. Every file is checked against the size the listing declared, because a
 * truncated download is the failure mode that does NOT announce itself — it writes a plausible
 * file and the mod fails later, somewhere else, for no visible reason.
 *
 * ## Writing
 *
 * Into a temporary folder first, then moved into place only once every file has arrived and
 * matched. A half-written mod folder is worse than no mod folder: the app's own scanner would
 * read it as installed, and the version ledger would record a version whose files are incomplete.
 */
import fs from "fs";
import path from "path";
import { request, type ServerRequestOptions } from "./sptServer";

export interface ServerFileEntry {
  path: string;
  sizeBytes: number;
}

export interface ServerFileListing {
  /** "file" when the mod is one loose file (companion 1.3.0); otherwise a folder. */
  kind?: "file" | "folder";
  files: ServerFileEntry[];
  error?: string;
}

/** user/mods, BepInEx/plugins, or BepInEx/patchers (companion 1.3.0). */
export type ModHalf = "server" | "client" | "patchers";

export const MOD_HALVES: readonly ModHalf[] = ["server", "client", "patchers"];

/**
 * A mod folder's contents, as the server sees them.
 *
 * Returns an error rather than throwing for "no such mod": a server legitimately may not have a
 * mod under the name being asked about, and that is an answer, not a fault.
 */
export async function listServerModFiles(
  origin: string,
  half: ModHalf,
  modId: string,
  options: ServerRequestOptions = {}
): Promise<ServerFileListing> {
  const url = `/sptarky/filelist/${half}/${encodeURIComponent(modId)}`;
  const { status, body } = await request(origin, url, options.timeoutMs ?? 15000, options.headers);
  if (status !== 200) return { files: [], error: `The server answered ${status} for that mod's file list.` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return { files: [], error: "The server's file list could not be read." };
  }

  const raw = parsed as { kind?: unknown; files?: unknown; error?: unknown };
  if (typeof raw?.error === "string" && raw.error) return { files: [], error: raw.error };
  if (!Array.isArray(raw?.files)) return { files: [], error: "The server did not return a file list." };

  const files: ServerFileEntry[] = [];
  for (const entry of raw.files) {
    const e = entry as { path?: unknown; sizeBytes?: unknown };
    if (typeof e?.path !== "string" || !e.path) continue;
    files.push({ path: e.path, sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : -1 });
  }
  return { kind: raw.kind === "file" ? "file" : "folder", files };
}

/** One file's bytes, verified against the size the listing promised. */
export async function fetchServerModFile(
  origin: string,
  half: ModHalf,
  modId: string,
  relativePath: string,
  expectedBytes: number,
  options: ServerRequestOptions = {}
): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
  // Each segment is encoded separately: the path is relative and may be nested, and encoding the
  // whole string would turn its separators into %2F and lose the structure the server needs.
  const encoded = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  // An empty relative path is a mod that IS one file: it is addressed by its own name, with
  // nothing after it. Checked against companions 1.2.0 and 1.3.0, which both serve that form.
  const url = `/sptarky/filedata/${half}/${encodeURIComponent(modId)}${encoded ? `/${encoded}` : ""}`;

  const { status, body } = await request(origin, url, options.timeoutMs ?? 120000, options.headers, { raw: true });
  if (status !== 200) return { ok: false, error: `${relativePath}: the server answered ${status}.` };

  // The check that matters. A truncated file is the failure that stays silent — it writes
  // something plausible and the mod breaks later, somewhere else, for no apparent reason.
  if (expectedBytes >= 0 && body.length !== expectedBytes) {
    return { ok: false, error: `${relativePath}: expected ${expectedBytes} bytes, got ${body.length}.` };
  }
  return { ok: true, data: body };
}

export interface ServerInstallResult {
  success: boolean;
  message: string;
  files?: number;
  bytes?: number;
}

export interface ServerPullOptions extends ServerRequestOptions {
  onProgress?: (done: number, total: number, bytes: number) => void;
  /**
   * What the server's manifest says this entry is. A loose file with a known size is fetched
   * directly, without asking for a file list — which a companion before 1.3.0 refuses for a
   * single file even though it serves the file itself. Absent: ask the file list.
   */
  entry?: { kind?: "file" | "folder"; sizeBytes?: number };
  /**
   * Where to stage the download, on the same volume as `targetRoot`. Defaults to inside
   * `targetRoot`. Pass a folder OUTSIDE it for BepInEx/plugins and BepInEx/patchers: BepInEx loads
   * every DLL under those folders recursively, so a staging folder left behind by a crash would
   * be loaded as a mod.
   */
  stagingRoot?: string;
}

/**
 * Pulls one mod from the server into the local install: a whole folder, or a mod that is one
 * loose file (ShowMeTheMoney's client half is `SwiftXP.ShowMeTheMoney.dll`, nothing else).
 *
 * `targetRoot` is the directory the mod goes INTO — `BepInEx/plugins`, `BepInEx/patchers` or
 * `user/mods`. Nothing outside `targetRoot/modId` is ever written, apart from staging.
 */
export async function installModFromServer(
  origin: string,
  half: ModHalf,
  modId: string,
  targetRoot: string,
  options: ServerPullOptions = {}
): Promise<ServerInstallResult> {
  // A mod id is a folder name and nothing else. It arrives from the server's own listing, but
  // this writes to disk, so it is checked here rather than trusted: a separator or a ".." would
  // otherwise place files anywhere the app can write.
  if (!modId || /[\\/]/.test(modId) || modId === "." || modId === "..") {
    return { success: false, message: `"${modId}" is not a valid mod folder name.` };
  }

  if (options.entry?.kind === "file" && typeof options.entry.sizeBytes === "number") {
    return installSingleFileFromServer(origin, half, modId, targetRoot, options.entry.sizeBytes, options);
  }

  const listing = await listServerModFiles(origin, half, modId, options);
  if (listing.error) return { success: false, message: listing.error };
  if (listing.kind === "file") {
    // Named by its own file name, so the one entry must be exactly that. Anything else is a
    // listing this code does not understand, and a write based on it would be a guess.
    const only = listing.files[0];
    if (listing.files.length !== 1 || !only || only.path !== modId) {
      return { success: false, message: `The server described "${modId}" as a single file but listed something else.` };
    }
    return installSingleFileFromServer(origin, half, modId, targetRoot, only.sizeBytes, options);
  }
  if (listing.files.length === 0) return { success: false, message: `The server reported no files for "${modId}".` };

  const destination = path.join(targetRoot, modId);
  // Staged on the same volume rather than in the system temp folder, so the final move is a
  // rename — atomic, and not a cross-device copy that can half-finish.
  const staging = options.stagingRoot ? path.join(options.stagingRoot, modId) : path.join(targetRoot, `.sptarky-pull-${modId}`);

  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    let bytes = 0;
    let done = 0;
    for (const entry of listing.files) {
      const result = await fetchServerModFile(origin, half, modId, entry.path, entry.sizeBytes, options);
      if (!result.ok) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { success: false, message: `Could not pull "${modId}" from the server. ${result.error}` };
      }

      // The containment check, on this side too. The server resolves paths safely, but a client
      // writing files must not depend on a remote machine having got that right.
      const target = path.resolve(staging, entry.path);
      if (!target.startsWith(path.resolve(staging) + path.sep)) {
        fs.rmSync(staging, { recursive: true, force: true });
        return { success: false, message: `The server offered a file outside the mod folder ("${entry.path}"). Nothing was installed.` };
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, result.data);
      bytes += result.data.length;
      done++;
      options.onProgress?.(done, listing.files.length, bytes);
    }

    // Only now is the old copy touched. Up to this point a failure leaves the install exactly as
    // it was, which is the whole reason for staging.
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    removeIfEmpty(options.stagingRoot);

    return {
      success: true,
      files: done,
      bytes,
      message: `Pulled ${done} file(s), ${formatBytes(bytes)}, straight from the server.`
    };
  } catch (err: any) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      removeIfEmpty(options.stagingRoot);
    } catch {
      /* the staging folder is already gone, or locked — not worth reporting over the real error */
    }
    return { success: false, message: `Could not install "${modId}" from the server: ${err?.message ?? err}` };
  }
}

/**
 * A mod that is one file: fetched by its own name, checked against the size the server declared,
 * staged, then moved into place over any older copy.
 *
 * The staged name ends in `.part`, never `.dll`, so nothing that scans for assemblies can mistake
 * a half-finished download for a mod.
 */
async function installSingleFileFromServer(
  origin: string,
  half: ModHalf,
  name: string,
  targetRoot: string,
  expectedBytes: number,
  options: ServerPullOptions
): Promise<ServerInstallResult> {
  const destination = path.join(targetRoot, name);
  const staged = options.stagingRoot ? path.join(options.stagingRoot, `${name}.part`) : path.join(targetRoot, `.sptarky-pull-${name}.part`);

  const result = await fetchServerModFile(origin, half, name, "", expectedBytes, options);
  if (!result.ok) {
    // The relative path is empty, so the fetch's own message starts with ": " — name the file.
    return { success: false, message: `Could not pull "${name}" from the server. ${name}${result.error}` };
  }

  try {
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, result.data);
    fs.mkdirSync(targetRoot, { recursive: true });
    // Replaces an older copy whatever shape it had. Only now, after the bytes are in hand.
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staged, destination);
    removeIfEmpty(options.stagingRoot);
    options.onProgress?.(1, 1, result.data.length);
    return {
      success: true,
      files: 1,
      bytes: result.data.length,
      message: `Pulled ${name} (${formatBytes(result.data.length)}) straight from the server.`
    };
  } catch (err: any) {
    try {
      fs.rmSync(staged, { force: true });
      removeIfEmpty(options.stagingRoot);
    } catch {
      /* already gone or locked — not worth reporting over the real error */
    }
    return { success: false, message: `Could not install "${name}" from the server: ${err?.message ?? err}` };
  }
}

/** Tidies a staging folder this module created, once nothing is left in it. Never removes anything with content. */
function removeIfEmpty(dir: string | undefined): void {
  if (!dir) return;
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* in use by a concurrent pull, or locked — harmless to leave */
  }
}


/**
 * An addon as the server described it, narrowed to what pulling one actually needs.
 *
 * `parentFiles` is the whole reason this is possible. A merged addon has no folder of its own —
 * its files live inside its parent — so without a record of WHICH files are its, there is nothing
 * to ask the server for. That list is exactly what the addon ledger records at install time.
 */
export interface ServerAddonPull {
  name: string;
  /** The parent's FOLDER name on the server, which is what the file routes are addressed by. */
  parentName: string;
  parentHalf: ModHalf;
  mergedIntoParent: boolean;
  /** Relative to the parent's folder. Merged addons only. */
  parentFiles: string[];
  /** Folders of its own. Own-folder addons only. */
  folders: { id: string; half: ModHalf }[];
}

/**
 * Resolves a relative path from a REMOTE machine against a local folder, or refuses.
 *
 * The paths below are chosen by another machine, so they are input, not data. The check is done
 * on canonical full paths after resolution, which is what makes it robust — "..", absolute paths
 * and anything clever with separators all collapse before the comparison rather than having to be
 * pattern-matched out beforehand. Mirrors the containment check the companion does on its side;
 * both ends check, because either end alone is one bug away from writing anywhere.
 */
function withinFolder(root: string, relative: string): string | null {
  try {
    const fullRoot = path.resolve(root);
    const combined = path.resolve(fullRoot, relative);
    return combined.startsWith(fullRoot + path.sep) ? combined : null;
  } catch {
    return null;
  }
}

/**
 * Pulls an addon from the server into the local install.
 *
 * Two shapes, because addons have two. One with its own folder is just a mod-shaped pull. A
 * MERGED one is not: its files sit among its parent's, so this writes individual files INTO a
 * folder that already exists and must survive. Nothing outside the parent's folder is touched,
 * and nothing is touched at all until every file has arrived — a half-applied patch is worse than
 * an absent one, because the parent then runs with an inconsistent mixture and nothing says so.
 */
export async function installAddonFromServer(
  origin: string,
  addon: ServerAddonPull,
  localParentDir: string,
  targetRootFor: (half: ModHalf) => string,
  options: ServerRequestOptions & {
    onProgress?: (done: number, total: number, bytes: number) => void;
    /** The server manifest's word on one of the addon's own entries — a single DLL or a folder. */
    entryFor?: (half: ModHalf, id: string) => ServerPullOptions["entry"];
    /** Staging location per half; see ServerPullOptions.stagingRoot. */
    stagingRootFor?: (half: ModHalf) => string | undefined;
  } = {}
): Promise<ServerInstallResult> {
  if (!addon.mergedIntoParent) {
    // Own folders: each is a mod-shaped pull, and installModFromServer already stages, size-checks
    // and moves atomically. No reason to have a second copy of that.
    let files = 0;
    let bytes = 0;
    for (const folder of addon.folders) {
      // An own "folder" may be one loose DLL — Quick Sell's is SwiftXP.SPT.ShowMeTheMoney.QuickSell.dll —
      // so the manifest's word on its shape travels with it.
      const r = await installModFromServer(origin, folder.half, folder.id, targetRootFor(folder.half), {
        ...options,
        entry: options.entryFor?.(folder.half, folder.id),
        stagingRoot: options.stagingRootFor?.(folder.half)
      });
      if (!r.success) return r;
      files += r.files ?? 0;
      bytes += r.bytes ?? 0;
    }
    return {
      success: true,
      files,
      bytes,
      message: `Pulled "${addon.name}" (${addon.folders.length} folder(s), ${files} file(s), ${formatBytes(bytes)}) from the server.`
    };
  }

  if (addon.parentFiles.length === 0) {
    // The honest refusal. An empty list is not "this addon has no files" — it is "the machine
    // that installed it never recorded which files were its", which nothing here can reconstruct.
    return {
      success: false,
      message: `The server has no record of which files "${addon.name}" put into "${addon.parentName}", so there is nothing to ask it for. Reinstalling the addon on that machine would record them.`
    };
  }

  if (!fs.existsSync(localParentDir)) {
    // Named rather than implied: the fix is to install the parent, and a patch applied to nothing
    // would leave files in a folder no mod owns.
    return {
      success: false,
      message: `"${addon.parentName}" is not installed here, so there is nowhere to put "${addon.name}". Install it first.`
    };
  }

  const listing = await listServerModFiles(origin, addon.parentHalf, addon.parentName, options);
  if (listing.error) return { success: false, message: listing.error };
  const sizeByPath = new Map(listing.files.map((f) => [f.path.toLowerCase(), f.sizeBytes]));

  const staging = path.join(localParentDir, `.sptarky-addon-pull`);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    let bytes = 0;
    let done = 0;
    const staged: { relative: string; stagedAt: string }[] = [];

    for (const relative of addon.parentFiles) {
      // Checked against the STAGING folder, which has the same shape as the destination. A path
      // that cannot land inside staging cannot land inside the parent either.
      const stagedAt = withinFolder(staging, relative);
      if (!stagedAt) {
        return { success: false, message: `The server offered a file path that would land outside "${addon.parentName}": ${relative}` };
      }
      // Refused rather than skipped. A missing file means the server's copy of this addon is not
      // the one its ledger describes, and applying the rest would produce a patch that exists on
      // neither machine.
      const expected = sizeByPath.get(relative.toLowerCase());
      if (expected === undefined) {
        return { success: false, message: `The server no longer has "${relative}" inside "${addon.parentName}", so "${addon.name}" cannot be copied from it.` };
      }

      const result = await fetchServerModFile(origin, addon.parentHalf, addon.parentName, relative, expected, options);
      if (!result.ok) return { success: false, message: result.error };

      fs.mkdirSync(path.dirname(stagedAt), { recursive: true });
      fs.writeFileSync(stagedAt, result.data);
      staged.push({ relative, stagedAt });
      bytes += result.data.length;
      done++;
      options.onProgress?.(done, addon.parentFiles.length, bytes);
    }

    // Only now is the parent touched. Up to here a failure has written nothing but a staging
    // folder, and the install is exactly as it was.
    for (const { relative, stagedAt } of staged) {
      const target = withinFolder(localParentDir, relative);
      if (!target) continue; // already proven above; belt and braces before a write
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(stagedAt, target);
    }
    fs.rmSync(staging, { recursive: true, force: true });

    return {
      success: true,
      files: done,
      bytes,
      message: `Applied "${addon.name}" to "${addon.parentName}" — ${done} file(s), ${formatBytes(bytes)}, straight from the server.`
    };
  } catch (err: any) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* already gone or locked — not worth reporting over the real error */
    }
    return { success: false, message: `Could not copy "${addon.name}" from the server: ${err?.message ?? err}` };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
