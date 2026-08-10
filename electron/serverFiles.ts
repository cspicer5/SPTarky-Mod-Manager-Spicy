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
  files: ServerFileEntry[];
  error?: string;
}

export type ModHalf = "server" | "client";

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

  const raw = parsed as { files?: unknown; error?: unknown };
  if (typeof raw?.error === "string" && raw.error) return { files: [], error: raw.error };
  if (!Array.isArray(raw?.files)) return { files: [], error: "The server did not return a file list." };

  const files: ServerFileEntry[] = [];
  for (const entry of raw.files) {
    const e = entry as { path?: unknown; sizeBytes?: unknown };
    if (typeof e?.path !== "string" || !e.path) continue;
    files.push({ path: e.path, sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : -1 });
  }
  return { files };
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
  const url = `/sptarky/filedata/${half}/${encodeURIComponent(modId)}/${encoded}`;

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

/**
 * Pulls one mod's whole folder from the server into the local install.
 *
 * `targetRoot` is the directory the mod's folder goes INTO — `BepInEx/plugins` or `user/mods`.
 * Nothing outside `targetRoot/modId` is ever written.
 */
export async function installModFromServer(
  origin: string,
  half: ModHalf,
  modId: string,
  targetRoot: string,
  options: ServerRequestOptions & { onProgress?: (done: number, total: number, bytes: number) => void } = {}
): Promise<ServerInstallResult> {
  // A mod id is a folder name and nothing else. It arrives from the server's own listing, but
  // this writes to disk, so it is checked here rather than trusted: a separator or a ".." would
  // otherwise place files anywhere the app can write.
  if (!modId || /[\\/]/.test(modId) || modId === "." || modId === "..") {
    return { success: false, message: `"${modId}" is not a valid mod folder name.` };
  }

  const listing = await listServerModFiles(origin, half, modId, options);
  if (listing.error) return { success: false, message: listing.error };
  if (listing.files.length === 0) return { success: false, message: `The server reported no files for "${modId}".` };

  const destination = path.join(targetRoot, modId);
  // Staged beside the destination rather than in the system temp folder, so the final move is a
  // rename on the same volume — atomic, and not a cross-device copy that can half-finish.
  const staging = path.join(targetRoot, `.sptarky-pull-${modId}`);

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

    return {
      success: true,
      files: done,
      bytes,
      message: `Pulled ${done} file(s), ${formatBytes(bytes)}, straight from the server.`
    };
  } catch (err: any) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* the staging folder is already gone, or locked — not worth reporting over the real error */
    }
    return { success: false, message: `Could not install "${modId}" from the server: ${err?.message ?? err}` };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
