/**
 * Whether the SPTarky companion is there — on this instance, and on the server.
 *
 * Two INDEPENDENT facts, shown as two indicators, because they answer different questions and
 * are false in different ways:
 *
 *   this instance   a fact about disk. The DLL is in user/mods, or it is not.
 *   the server      a fact about a live process. It can only be known while connected, and a
 *                   server that is merely off is not a server without the companion.
 *
 * Collapsing them into one "companion: yes/no" would be wrong in both directions — installing
 * it here does nothing for a server on another machine, and a server having it says nothing
 * about this PC.
 *
 * The third state, "not known", is deliberately visible rather than defaulted to "no". Not
 * connected to a server is the ordinary case, and rendering that as absence would have someone
 * install a mod onto a machine that already has it.
 */
import { CompanionInstallState } from "./types";
import { CompanionServerState } from "./companionState";

export { readServerCompanion } from "./companionState";

export default function CompanionStatus({
  local,
  server,
  busy,
  onInstall,
  onRemove
}: {
  local: CompanionInstallState | null;
  server: CompanionServerState;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  // A client-only folder can never take a server mod. Saying nothing at all beats an
  // indicator that is permanently grey for a reason the user cannot act on.
  if (local && !local.canInstall && !local.installed) return null;

  const installed = local?.installed === true;

  // "This PC" and "Remote Server", not "local/server": the companion is a SERVER mod, so both
  // indicators are about SPT servers. What separates them is which MACHINE, and naming the
  // machine is the only labelling that makes that unambiguous.
  const serverLabel =
    server.kind === "active"
      ? `Remote Server: active${server.version ? ` v${server.version}` : ""}`
      : server.kind === "absent"
        ? "Remote Server: not installed"
        : server.kind === "unreachable"
          ? "Remote Server: unreachable"
          : server.kind === "unchecked"
            ? "Remote Server: not checked"
            : "Remote Server: not tracked";

  const serverTitle =
    server.kind === "active"
      ? "This server is reporting the companion, so its mod versions are read from its own records rather than from what each mod declares."
      : server.kind === "absent"
        ? (server.reason ?? "The remote server answered, but has no companion. Its versions are only what each mod declares about itself.") +
          " Run this manager on that machine to install it there — it cannot be installed across the network."
        : server.kind === "unreachable"
          ? "The server could not be reached, so whether it has the companion is UNKNOWN — this is not a sign that it lacks one."
          : server.kind === "unchecked"
            ? "This server has not been contacted yet. Open the server view to check it."
            : "No server is being tracked, so nothing is known about one.";

  return (
    <div className="companion-status">
      {/* A titled box, not a row of loose chips. The two indicators below only make sense as a
          pair belonging to one optional mod; unlabelled and inline they read as a general
          this-PC/remote-server status for the whole app. */}
      <span className="companion-label" title="The SPTarky server companion — an optional SPT server mod that reports real installed versions and client mods.">
        Companion Server App
      </span>
      <div className="companion-row">
      <span
        className={`companion-dot ${installed ? "on" : "off"}`}
        title={
          installed
            ? `Installed in this instance's SPT server${local?.targetDir ? ` at ${local.targetDir}` : ""}. It does something only while that server is running.`
            : "Not installed in this instance's SPT server. It is a server mod, so install it on whichever PC runs the server."
        }
      >
        {installed ? "This PC: installed" : "This PC: not installed"}
      </span>

      <span className={`companion-dot server-${server.kind}`} title={serverTitle}>
        {serverLabel}
      </span>

      {installed ? (
        <>
          {local?.differsFromBundled && (
            <button className="companion-btn" onClick={onInstall} disabled={busy} title="Overwrite it with the build this manager ships, then restart the server.">
              Update
            </button>
          )}
          <button className="companion-btn" onClick={onRemove} disabled={busy} title="Delete it from this instance. Your config, and the token in it, go too.">
            Remove
          </button>
        </>
      ) : (
        <button
          className="companion-btn primary"
          onClick={onInstall}
          disabled={busy || !local?.canInstall}
          title={local?.targetDir ? `Writes to ${local.targetDir}` : (local?.reason ?? "Install the companion into this instance")}
        >
          {busy ? "…" : "Install companion"}
        </button>
      )}
      </div>
    </div>
  );
}
