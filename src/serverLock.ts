/**
 * Locking the app's SPT version to the server you are about to play on.
 *
 * Lives under src/ rather than electron/ because the button is in the renderer and the
 * renderer cannot import main-process modules. It is pure — no IPC, no fetch — so the
 * awkward cases are testable without a server.
 */
export type SptVersionLockPlan =
  /** The server never said, so there is nothing to lock to. */
  | { kind: "unavailable"; reason: string }
  /** Already on the server's version — pressing the button again should do nothing loudly. */
  | { kind: "already-matching"; version: string }
  | {
      kind: "lock";
      version: string;
      /** What it was, for a message that says what changed. */
      previousVersion?: string;
      /**
       * The server runs a DIFFERENT SPT from the one installed here. Locking still happens —
       * it is what you asked for — but it does not fix this, and saying so is the point.
       */
      instanceMismatch?: string;
    };

/**
 * Decides what "Lock to server" should do.
 *
 * Separated from the button so the awkward parts are testable: a server that never reported a
 * version, a press that changes nothing, and the case that actually matters — locking to a
 * server whose SPT differs from the one installed here.
 *
 * That last case is the reason this is not simply `setVersion(server.sptVersion)`. Matching the
 * catalogue to the server does NOT make a 4.0.13 install able to join a 4.1.2 server; it only
 * changes which mods you are shown. Presenting that as success would send someone off to
 * install a set of mods that cannot work until they upgrade SPT itself, so the plan carries the
 * mismatch and the caller is expected to say it out loud.
 */
export function planSptVersionLock(args: {
  serverVersion?: string;
  currentVersion?: string;
  instanceVersion?: string;
}): SptVersionLockPlan {
  const server = (args.serverVersion ?? "").trim();
  if (!server) {
    return {
      kind: "unavailable",
      reason: "This server did not report an SPT version, so there is nothing to lock to."
    };
  }

  const current = (args.currentVersion ?? "").trim();
  if (current === server) return { kind: "already-matching", version: server };

  const instance = (args.instanceVersion ?? "").trim();
  return {
    kind: "lock",
    version: server,
    previousVersion: current || undefined,
    // Compared against the INSTANCE, not against whatever the dropdown happened to show. The
    // dropdown may already have been overridden, and an override cannot tell you anything about
    // whether the install can actually join this server.
    instanceMismatch: instance && instance !== server ? instance : undefined
  };
}
