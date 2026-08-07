/**
 * Addons — compatibility and companion mods (v1.2.2).
 *
 * Three sections, because they answer three different questions:
 *
 *   Available   what could I add to the mods I already have? (the Forge catalogue, frozen)
 *   Installed   what is here, and what is it attached to? (read from the files, forever)
 *   Integrations what would light up extra behaviour in something I already run?
 *
 * The catalogue half stops being able to grow when Forge shuts down; the other two do not
 * depend on it at all. The panel says which is which rather than letting the distinction be
 * discovered on the 11th.
 */
import { useState } from "react";
import { AddonSuggestion, AddonLink, AddonIntegration, InstalledAddonRecord, ModInfo, ModType } from "./types";
import "./addons.css";

const FIT_LABEL: Record<string, string> = {
  declared: "fits your version",
  unconstrained: "no version info",
  none: "nothing fits your version"
};

function bytes(n?: number): string {
  if (!n) return "";
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function SuggestionRow({
  s,
  busy,
  onInstall
}: {
  s: AddonSuggestion;
  busy: boolean;
  onInstall: (id: number) => void;
}) {
  return (
    <li className={`addon-row addon-fit-${s.fit}`}>
      <div className="addon-row-main">
        <span className="addon-name" title={s.addon.teaser ?? s.addon.name}>
          {s.addon.name}
        </span>
        {s.installed && <span className="addon-badge addon-badge-have">installed</span>}
        <span className={`addon-badge addon-badge-${s.fit}`}>{FIT_LABEL[s.fit]}</span>
      </div>
      {s.addon.teaser && <span className="addon-teaser">{s.addon.teaser}</span>}
      <div className="addon-row-meta">
        <span>
          for <strong>{s.parentName}</strong>
          {s.parentVersion ? ` ${s.parentVersion}` : " (version unknown)"}
        </span>
        {s.pick ? (
          <span>
            v{s.pick.version}
            {/* The constraint is the whole reason the newest build is not always the right
                one, so it is shown rather than hidden behind the choice. */}
            {s.pick.modConstraint ? ` · needs parent ${s.pick.modConstraint}` : ""}
            {s.pick.bytes ? ` · ${bytes(s.pick.bytes)}` : ""}
          </span>
        ) : (
          // Actionable: the fix is to update the parent, not to go hunting for the addon.
          <span className="addon-warn">Update {s.parentName} to use this.</span>
        )}
      </div>
      <div className="addon-row-actions">
        <button
          className={s.fit === "declared" && !s.installed ? "primary" : ""}
          disabled={busy || !s.pick}
          onClick={() => onInstall(s.addon.id)}
          title={s.pick ? `Download and install v${s.pick.version}` : "No build supports the version you have installed"}
        >
          {s.installed ? "Reinstall" : "Install"}
        </button>
        {s.addon.detailUrl && (
          <a className="addon-link" href={s.addon.detailUrl} target="_blank" rel="noreferrer">
            Forge page
          </a>
        )}
      </div>
    </li>
  );
}

export default function AddonsPanel({
  suggestions,
  links,
  integrations,
  mods,
  busy,
  scanned,
  catalogueSize,
  ledger,
  onForgetAddon,
  onInstallForgeAddon,
  onInstallFromFile,
  onDetectLinks,
  onSetParent,
  onClose
}: {
  suggestions: AddonSuggestion[];
  links: AddonLink[];
  integrations: AddonIntegration[];
  mods: ModInfo[];
  busy: boolean;
  scanned: boolean;
  catalogueSize: number;
  ledger: InstalledAddonRecord[];
  onForgetAddon: (forgeAddonId?: number, name?: string) => void;
  onInstallForgeAddon: (addonId: number) => void;
  onInstallFromFile: (parentName: string) => void;
  onDetectLinks: () => void;
  onSetParent: (id: string, type: ModType, parent: string | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"available" | "installed" | "integrations">("available");
  const [manualParent, setManualParent] = useState("");
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  const usable = suggestions.filter((s) => s.fit !== "none");
  const visible = showAllSuggestions ? suggestions : usable;

  // Grouping by what the addon attaches to is the only ordering that reads naturally: an
  // addon means nothing on its own.
  const byParent = new Map<string, AddonLink[]>();
  for (const l of links) {
    const key = l.parentName ?? "(unknown)";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(l);
  }

  return (
    <div className="addon-panel">
      <div className="addon-header">
        <div>
          <strong>Addons</strong>
          <span className="addon-header-note">
            Compatibility and companion mods — a patch that makes two mods work together, a preset pack, a Fika sync
            shim.
          </span>
        </div>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="addon-tabs">
        <button className={tab === "available" ? "addon-tab-active" : ""} onClick={() => setTab("available")}>
          Available ({usable.length})
        </button>
        <button className={tab === "installed" ? "addon-tab-active" : ""} onClick={() => setTab("installed")}>
          Installed ({ledger.length + links.length})
        </button>
        <button className={tab === "integrations" ? "addon-tab-active" : ""} onClick={() => setTab("integrations")}>
          Could add ({integrations.length})
        </button>
      </div>

      {tab === "available" && (
        <div className="addon-body">
          {/* Said plainly rather than discovered later: this list is a snapshot and will not
              grow. Worded so it reads correctly both before and after 2026-08-10 — an earlier
              draft said Forge "shut down" while it was still up. */}
          <p className="addon-note">
            A snapshot of {catalogueSize} addons taken from Forge on 6 August 2026, before it closes on the 10th. This
            list does not grow: anything published later has to come from a file or GitHub.
          </p>

          {suggestions.length === 0 ? (
            <p className="empty-list">No catalogued addon attaches to a mod you have installed.</p>
          ) : (
            <>
              <ul className="addon-list">
                {visible.map((s) => (
                  <SuggestionRow key={s.addon.id} s={s} busy={busy} onInstall={onInstallForgeAddon} />
                ))}
              </ul>
              {suggestions.length > usable.length && (
                <label className="addon-toggle">
                  <input
                    type="checkbox"
                    checked={showAllSuggestions}
                    onChange={(e) => setShowAllSuggestions(e.target.checked)}
                  />
                  Show {suggestions.length - usable.length} that need a different parent version
                </label>
              )}
            </>
          )}

          <div className="addon-manual">
            <strong>Install an addon from a file</strong>
            <span className="addon-note">
              For anything not in the catalogue — a patch someone sent you, or one published after the shutdown.
            </span>
            <div className="addon-manual-row">
              <select value={manualParent} onChange={(e) => setManualParent(e.target.value)}>
                <option value="">Which mod is it for?…</option>
                {mods.map((m) => (
                  <option key={`${m.type}:${m.id}`} value={m.id}>
                    {m.id} {m.type === "server" ? "(server)" : "(client)"}
                  </option>
                ))}
              </select>
              <button disabled={!manualParent || busy} onClick={() => onInstallFromFile(manualParent)}>
                Choose a file…
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "installed" && (
        <div className="addon-body">
          {/* The ledger comes first because it is the only record of the addons that have no
              folder of their own — the scan below cannot see those at all, since there is
              nothing separate to look at. */}
          <div className="addon-section">
            <strong>Addons installed through the manager</strong>
            {ledger.length === 0 ? (
              <p className="empty-list">None yet.</p>
            ) : (
              <ul className="addon-list">
                {ledger.map((r) => (
                  <li key={`${r.forgeAddonId ?? r.name}:${r.parentName}`} className="addon-row">
                    <div className="addon-row-main">
                      <span className="addon-name">{r.name}</span>
                      {r.version && <span className="addon-badge">v{r.version}</span>}
                      <span className="addon-badge">{r.source}</span>
                      {/* Told up front rather than discovered at uninstall time. */}
                      {r.mergedIntoParent && (
                        <span
                          className="addon-badge addon-badge-merged"
                          title={`Its files are inside ${r.parentName}'s folder, so it can't be removed on its own.`}
                        >
                          inside {r.parentName}
                        </span>
                      )}
                      {/* Reinstalling a mod replaces its folder and takes any addon inside it
                          along — in silence, because nothing about the parent's row changes. */}
                      {r.needsReinstall && (
                        <span
                          className="addon-badge addon-badge-gone"
                          title={`${r.parentName} was reinstalled after this addon, which replaced the folder its files were in.`}
                        >
                          wiped by a reinstall
                        </span>
                      )}
                    </div>
                    <div className="addon-row-meta">
                      <span>
                        for <strong>{r.parentName}</strong>
                        {r.parentConstraint ? ` · needs parent ${r.parentConstraint}` : ""}
                      </span>
                      <span>{r.installedAt.slice(0, 10)}</span>
                    </div>
                    <div className="addon-row-actions">
                      {r.needsReinstall && typeof r.forgeAddonId === "number" && (
                        <button className="primary" disabled={busy} onClick={() => onInstallForgeAddon(r.forgeAddonId!)}>
                          Reinstall
                        </button>
                      )}
                      <button disabled={busy} onClick={() => onForgetAddon(r.forgeAddonId, r.name)}>
                        Forget
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="addon-actions">
            <button onClick={onDetectLinks} disabled={busy} className={scanned ? "" : "primary"}>
              {scanned ? "Re-scan" : "Scan installed mods"}
            </button>
            <span className="addon-note">
              Reads each plugin's own assembly for the dependencies it declares. Works with no Forge and no running
              server, so this keeps working after the shutdown.
            </span>
          </div>

          {!scanned ? (
            <p className="empty-list">Not scanned yet.</p>
          ) : links.length === 0 ? (
            <p className="empty-list">Nothing here declares a dependency on anything else installed.</p>
          ) : (
            <ul className="addon-tree">
              {[...byParent.entries()].map(([parent, children]) => (
                <li key={parent}>
                  <span className="addon-parent">{parent}</span>
                  <ul>
                    {children.map((l) => (
                      <li key={`${l.type}:${l.name}:${l.guid}`} className="addon-child">
                        <span className="addon-name">{l.name}</span>
                        {/* How a relationship was established, on the same provenance ladder
                            the rest of the app uses. A GUID a mod declares itself is stronger
                            evidence than anything inferred. */}
                        <span className={`addon-badge addon-method-${l.method}`}>{l.method}</span>
                        {l.guid && <span className="addon-guid">{l.guid}</span>}
                        <button
                          className="addon-unlink"
                          disabled={busy}
                          onClick={() => onSetParent(l.name, l.type, null)}
                          title="Stop treating this as an addon"
                        >
                          unlink
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "integrations" && (
        <div className="addon-body">
          {/* Framed as discovery, NOT as "missing dependencies". BepInEx dependencies carry a
              hard/soft flag that reading the assembly's strings cannot see, and on a working
              install these are soft by demonstration — a missing hard dependency stops the
              plugin loading at all. Calling them missing would raise alarms about a setup
              that runs fine. */}
          <p className="addon-note">
            Mods that something you already run knows how to work with. These are optional — your setup works without
            them — but installing one lights up extra behaviour.
          </p>
          {!scanned ? (
            <p className="empty-list">
              Scan on the Installed tab first.
            </p>
          ) : integrations.length === 0 ? (
            <p className="empty-list">Nothing found.</p>
          ) : (
            <ul className="addon-list">
              {integrations.map((i) => (
                <li key={`${i.name}:${i.guid}`} className="addon-row">
                  <div className="addon-row-main">
                    <span className="addon-name">{i.forgeName}</span>
                  </div>
                  <div className="addon-row-meta">
                    <span>
                      <strong>{i.name}</strong> knows how to work with this
                    </span>
                    <span className="addon-guid">{i.guid}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
