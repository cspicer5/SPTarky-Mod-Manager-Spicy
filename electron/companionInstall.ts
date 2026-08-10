/**
 * Installing the SPTarky companion into a local SPT server.
 *
 * The companion is a .NET DLL that ships inside this app. Installing it is a single file copy
 * into `<serverRoot>/user/mods/SptarkyCompanion/`, which is the whole reason it was built as
 * one self-contained assembly with no SPT DLLs beside it — there is nothing to unpack, nothing
 * to configure, and nothing that can half-succeed.
 *
 * It only ever writes to a LOCAL install. A remote server is on somebody else's filesystem, and
 * the manager has no business writing there even when it can read it — anyone hosting runs this
 * app on that machine and installs it from there.
 *
 * Restarting the server afterwards is the user's job and is stated plainly rather than done for
 * them: killing a running server can drop other people out of a raid.
 */
import fs from "fs";
import path from "path";

export const COMPANION_FOLDER = "SptarkyCompanion";
export const COMPANION_DLL = "SptarkyCompanion.dll";

/** Kept in step with the DLL that ships beside it, and shown so a stale copy is visible. */
export const BUNDLED_COMPANION_VERSION = "1.0.0";

export interface CompanionInstallState {
  /** False when there is no server half to install into — a client-only folder, say. */
  canInstall: boolean;
  installed: boolean;
  /** Where it is, or would go. Shown so nobody has to guess what the button will touch. */
  targetDir?: string;
  /** True when the installed file differs in size from the bundled one — i.e. an older build. */
  differsFromBundled?: boolean;
  /** Whether the owner has switched a token on. Read from the config the mod itself writes. */
  requiresToken?: boolean;
  reason?: string;
}

/**
 * Reports what installing would do, without doing it.
 *
 * Deliberately reports `differsFromBundled` by SIZE rather than claiming a version. The DLL
 * carries a version internally but reading it needs PE metadata parsing, and a wrong version
 * shown confidently is worse than an honest "this is not the build I ship".
 */
export function readInstallState(serverRoot: string | undefined, bundledDll: string): CompanionInstallState {
  if (!serverRoot) {
    return { canInstall: false, installed: false, reason: "No SPT instance is selected." };
  }
  const modsDir = path.join(serverRoot, "user", "mods");
  if (!fs.existsSync(modsDir)) {
    return {
      canInstall: false,
      installed: false,
      reason: "This instance has no user/mods folder, so it is not a server install."
    };
  }

  const targetDir = path.join(modsDir, COMPANION_FOLDER);
  const targetDll = path.join(targetDir, COMPANION_DLL);
  if (!fs.existsSync(targetDll)) return { canInstall: true, installed: false, targetDir };

  let differsFromBundled: boolean | undefined;
  try {
    differsFromBundled = fs.statSync(targetDll).size !== fs.statSync(bundledDll).size;
  } catch {
    /* cannot compare — leave it unstated rather than guess */
  }

  // The mod writes this itself on first run; its absence just means it has not started yet.
  let requiresToken: boolean | undefined;
  try {
    const cfg = path.join(targetDir, "config.json");
    if (fs.existsSync(cfg)) requiresToken = JSON.parse(fs.readFileSync(cfg, "utf-8"))?.requireToken === true;
  } catch {
    /* a corrupt config is the mod's problem to report, not this dialog's */
  }

  return { canInstall: true, installed: true, targetDir, differsFromBundled, requiresToken };
}

export interface CompanionInstallResult {
  ok: boolean;
  message: string;
  targetDir?: string;
}

/**
 * Copies the bundled DLL into the instance.
 *
 * Overwrites an existing copy on purpose — that is how upgrading works, and the alternative
 * (refusing when present) would leave someone stuck on an old build with no way forward from
 * the UI. Nothing else in the folder is touched, so a config.json the owner has edited, token
 * and all, survives.
 */
export function installCompanion(serverRoot: string | undefined, bundledDll: string): CompanionInstallResult {
  const state = readInstallState(serverRoot, bundledDll);
  if (!state.canInstall || !state.targetDir) {
    return { ok: false, message: state.reason ?? "This instance cannot take the companion." };
  }
  if (!fs.existsSync(bundledDll)) {
    return { ok: false, message: "The companion is missing from this build of the manager." };
  }

  try {
    fs.mkdirSync(state.targetDir, { recursive: true });
    // Read-then-write rather than copyFileSync: in a packaged build the source is INSIDE
    // app.asar, and readFileSync is the asar-aware path that is certain to work there.
    fs.writeFileSync(path.join(state.targetDir, COMPANION_DLL), fs.readFileSync(bundledDll));
  } catch (err: any) {
    return { ok: false, message: explainFileLock(err, "install") };
  }

  return {
    ok: true,
    targetDir: state.targetDir,
    // Says what has to happen next. A mod that is on disk but not loaded looks identical to one
    // that failed, and people conclude the install did not work.
    message: state.installed
      ? "Companion updated. Restart the SPT server for it to take effect."
      : "Companion installed. Restart the SPT server, then reconnect."
  };
}

/**
 * Removes the companion, and only the companion.
 *
 * Scoped to the two files this app put there rather than deleting the folder wholesale: the
 * folder is a plausible place for someone to have left something of their own, and a recursive
 * delete of a path assembled from settings is exactly the operation worth not writing.
 */
export function removeCompanion(serverRoot: string | undefined): CompanionInstallResult {
  if (!serverRoot) return { ok: false, message: "No SPT instance is selected." };
  const targetDir = path.join(serverRoot, "user", "mods", COMPANION_FOLDER);
  if (!fs.existsSync(targetDir)) return { ok: true, message: "The companion was not installed.", targetDir };

  try {
    for (const name of [COMPANION_DLL, "config.json"]) {
      const file = path.join(targetDir, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    // Only if nothing else is in there.
    if (fs.readdirSync(targetDir).length === 0) fs.rmdirSync(targetDir);
  } catch (err: any) {
    return { ok: false, message: explainFileLock(err, "remove") };
  }

  return { ok: true, targetDir, message: "Companion removed. Restart the SPT server to unload it." };
}

/**
 * Turns a file-lock error into the sentence that actually helps.
 *
 * Found by clicking the button with the server running: Windows refuses to unlink a DLL that a
 * live process has loaded, and Node surfaces that as
 * `EPERM: operation not permitted, unlink '...SptarkyCompanion.dll'`. That is a true statement
 * and a useless one — it names a syscall, not the running SPT server holding the file, and not
 * the one thing that fixes it.
 *
 * Windows reports this as EPERM here, but EBUSY and EACCES are the same situation from the
 * user's side, so all three get the same answer.
 */
function explainFileLock(err: any, verb: "install" | "remove"): string {
  const code = err?.code ?? "";
  if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
    return `Could not ${verb} the companion because the SPT server is using it. Stop the server, then try again.`;
  }
  return `Could not ${verb} the companion: ${err?.message ?? err}`;
}
