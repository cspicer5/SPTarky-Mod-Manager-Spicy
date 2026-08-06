/**
 * Mod presets — phase 1 UI.
 *
 * Two halves: the presets you have saved, and a reconciliation of the selected one against
 * the current install. The report is deliberately the same shape as the server and headless
 * ones — install these, fix these, you have these extra — because it is the same question.
 *
 * What Apply does is narrower than the word suggests, and the panel says so rather than
 * letting the user find out: it can switch mods on and off, but it cannot conjure a mod that
 * is not installed. That needs payloads (phase 3) or Forge.
 */
import { useState } from "react";
import {
  Preset,
  PresetReport,
  PresetRow,
  PresetStoreStatus,
  PayloadProgress,
  StoreUsage,
  WritePolicy
} from "./types";
import "./presets.css";

const ISSUE_LABEL: Record<string, string> = {
  missing: "Not installed",
  "version-mismatch": "Different version",
  "state-mismatch": "Wrong on/off state",
  "unknown-version": "Can't compare",
  extra: "Not in preset"
};

function PresetRowItem({ row }: { row: PresetRow }) {
  return (
    <li className={`preset-row ${row.issue ? `preset-issue-${row.issue}` : ""}`}>
      <div className="preset-row-main">
        <span className="preset-row-name" title={row.guid ? `GUID: ${row.guid}` : row.name}>
          {row.name}
        </span>
        {/* The preset records enabled/disabled per mod, but nothing showed it — so a preset
            containing two deliberately-disabled mods looked like it had not captured that
            at all. Shown on every row, not only on a mismatch. */}
        {row.presetEnabled !== undefined && (
          <span
            className={`preset-state ${row.presetEnabled ? "on" : "off"}`}
            title={`This preset expects the mod to be ${row.presetEnabled ? "enabled" : "disabled"}.`}
          >
            {row.presetEnabled ? "on" : "off"}
          </span>
        )}
        <span className={`type-badge type-${row.type}`}>{row.type}</span>
        {!row.required && (
          <span className="preset-optional" title="Part of this preset, but you can play without it.">
            optional
          </span>
        )}
      </div>
      <div className="preset-row-meta">
        {row.issue && (
          <span className={`preset-issue preset-issue-tag-${row.issue}`} title={row.detail ?? ""}>
            {ISSUE_LABEL[row.issue] ?? row.issue}
          </span>
        )}
        {row.issue === "version-mismatch" && (
          <span className="preset-versions">
            want {row.presetVersion} · have {row.localVersion}
          </span>
        )}
        {row.issue === "state-mismatch" && (
          <span className="preset-versions">
            want {row.presetEnabled ? "on" : "off"} · is {row.localEnabled ? "on" : "off"}
          </span>
        )}
        {!row.issue && row.localVersion && <span className="preset-versions">v{row.localVersion}</span>}
        {/* A name match is weaker than a GUID match and is shown as such, the same as
            everywhere else in the app. */}
        {row.matchedBy === "name" && row.issue !== "extra" && (
          <span className="preset-weak" title="Matched by folder name, not GUID.">
            name match?
          </span>
        )}
      </div>
    </li>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Progress for a copy that can run for tens of minutes.
 *
 * Shows the mod and the file, not just a bar. "Copying WTT-ContentBackport, 812 of 1179
 * files" is the difference between a user waiting and a user killing the app because it
 * looks hung — that mod alone is 4.76 GB.
 */
function PayloadProgressBar({ progress, onCancel }: { progress: PayloadProgress; onCancel: () => void }) {
  const pct = progress.bytesTotal > 0 ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100) : 0;
  return (
    <div className="preset-payload-progress">
      <div className="preset-payload-head">
        <span className="preset-payload-mod">
          {progress.phase === "publish" ? "Copying to the store" : "Installing"}: <strong>{progress.mod}</strong>
        </span>
        <button onClick={onCancel} title="Stop after the current file. Progress is kept and resumes next time.">
          Stop
        </button>
      </div>
      <div className="preset-payload-track">
        <div className="preset-payload-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="preset-payload-meta">
        <span>
          mod {Math.min(progress.modsDone + 1, progress.modsTotal)} of {progress.modsTotal}
          {progress.filesTotal ? ` · file ${progress.filesDone} of ${progress.filesTotal}` : ""}
        </span>
        <span>
          {formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}
          {progress.bytesReused ? ` · ${formatBytes(progress.bytesReused)} reused` : ""}
        </span>
      </div>
      {progress.file && (
        <span className="preset-payload-file" title={progress.file}>
          {progress.file}
        </span>
      )}
    </div>
  );
}

/**
 * The shared store: connect to a folder, see what is in it, publish and import.
 *
 * Kept collapsed until opened. Someone playing alone never needs a store, and the panel's
 * first job is still "compare this install against a preset" — pushing a sharing setup in
 * front of that would make the common case look harder than it is.
 */
function StoreSection({
  status,
  identity,
  busy,
  usage,
  progress,
  selectedPresetName,
  canPublishSelected,
  onChoose,
  onCreate,
  onDisconnect,
  onSetIdentity,
  onSetPolicy,
  onPublish,
  onPublishWithPayloads,
  onUnpublish,
  onImport,
  onInstallPayloads,
  onVerifyPayloads,
  onCleanStore,
  onCancelPayloads,
  onImportFile
}: {
  status: PresetStoreStatus | null;
  identity: string;
  busy: boolean;
  usage: StoreUsage | null;
  progress: PayloadProgress | null;
  selectedPresetName: string | null;
  canPublishSelected: boolean;
  onChoose: () => void;
  onCreate: (name: string, policy: WritePolicy) => void;
  onDisconnect: () => void;
  onSetIdentity: (name: string) => void;
  onSetPolicy: (policy: WritePolicy) => void;
  onPublish: () => void;
  onPublishWithPayloads: () => void;
  onUnpublish: (id: string) => void;
  onImport: (id: string) => void;
  onInstallPayloads: (id: string) => void;
  onVerifyPayloads: (id: string, deep: boolean) => void;
  onCleanStore: () => void;
  onCancelPayloads: () => void;
  onImportFile: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [storeName, setStoreName] = useState("");
  const [policy, setPolicy] = useState<WritePolicy>("shared");
  const [identityDraft, setIdentityDraft] = useState(identity);
  const [editingIdentity, setEditingIdentity] = useState(false);

  const connected = status?.connected === true;
  const chosen = !!status?.path;

  return (
    <div className="preset-store">
      <button className="preset-store-toggle" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"} Sharing</span>
        <span className="preset-store-summary">
          {connected
            ? `${status?.info?.name} · ${status?.entries.length ?? 0} shared`
            : chosen
              ? "folder chosen, no store yet"
              : "not connected"}
        </span>
      </button>

      {open && (
        <div className="preset-store-body">
          {/* Sending someone the file needs no store at all, so it comes first: it is the
              lowest-effort way to share and the one most people will actually use. */}
          <div className="preset-store-files">
            <div className="preset-store-files-text">
              <strong>Send a file</strong>
              <span>A preset is a small file. Export one to send a friend, or import one they sent you.</span>
            </div>
            <button onClick={onImportFile} disabled={busy}>
              Import a preset file…
            </button>
          </div>

          <div className="preset-store-identity">
            <span className="preset-store-label">Publishing as</span>
            {editingIdentity ? (
              <>
                <input
                  type="text"
                  value={identityDraft}
                  autoFocus
                  onChange={(e) => setIdentityDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && identityDraft.trim()) {
                      onSetIdentity(identityDraft.trim());
                      setEditingIdentity(false);
                    }
                    if (e.key === "Escape") setEditingIdentity(false);
                  }}
                />
                <button
                  disabled={!identityDraft.trim()}
                  onClick={() => {
                    onSetIdentity(identityDraft.trim());
                    setEditingIdentity(false);
                  }}
                >
                  Save
                </button>
              </>
            ) : (
              <>
                <strong>{identity || "not set"}</strong>
                <button
                  onClick={() => {
                    setIdentityDraft(identity);
                    setEditingIdentity(true);
                  }}
                  title="The name your published presets carry"
                >
                  Change
                </button>
              </>
            )}
          </div>

          {!connected ? (
            <div className="preset-store-connect">
              <p className="preset-store-help">
                A store is just a folder everyone can reach — a network share, a VPN path, or a synced folder. Presets
                published there show up for anyone pointed at it.
              </p>
              <div className="preset-store-actions">
                <button onClick={onChoose} disabled={busy}>
                  {chosen ? "Choose a different folder…" : "Choose a folder…"}
                </button>
              </div>
              {chosen && (
                <>
                  <p className="preset-store-path" title={status?.path}>
                    {status?.path}
                  </p>
                  {status?.message && <p className="preset-store-warn">{status.message}</p>}
                  <div className="preset-store-create">
                    <input
                      type="text"
                      placeholder="Name this store…"
                      value={storeName}
                      onChange={(e) => setStoreName(e.target.value)}
                    />
                    <select value={policy} onChange={(e) => setPolicy(e.target.value as WritePolicy)}>
                      <option value="shared">Anyone can publish</option>
                      <option value="curated">Only I can publish</option>
                    </select>
                    <button
                      className="primary"
                      disabled={!storeName.trim() || busy}
                      onClick={() => onCreate(storeName.trim(), policy)}
                    >
                      Create store here
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="preset-store-connected">
              <div className="preset-store-head">
                <div>
                  <strong>{status?.info?.name}</strong>
                  <span className="preset-store-path" title={status?.path}>
                    {status?.path}
                  </span>
                </div>
                <button onClick={onDisconnect} disabled={busy} title="Stop using this store. Nothing is deleted.">
                  Disconnect
                </button>
              </div>

              <div className="preset-store-policy">
                <span>
                  {status?.info?.writePolicy === "curated"
                    ? `Curated by ${status?.info?.owner || "the owner"}`
                    : "Anyone with access can publish"}
                </span>
                {/* Said out loud rather than implied: this is an agreement between clients,
                    not a lock. Whoever can write to the folder can change it. */}
                <span className="preset-store-note">
                  A convention between clients, not a permission — the folder's own access controls it.
                </span>
                {status?.info?.owner?.toLowerCase() === identity.toLowerCase() && (
                  <button
                    disabled={busy}
                    onClick={() => onSetPolicy(status?.info?.writePolicy === "curated" ? "shared" : "curated")}
                  >
                    {status?.info?.writePolicy === "curated" ? "Let anyone publish" : "Make it curated"}
                  </button>
                )}
              </div>

              {progress && <PayloadProgressBar progress={progress} onCancel={onCancelPayloads} />}

              <div className="preset-store-publish">
                <div className="preset-store-actions">
                  <button
                    disabled={busy || !canPublishSelected}
                    onClick={onPublish}
                    title={
                      !selectedPresetName
                        ? "Pick one of your presets first"
                        : status?.canPublish
                          ? `Share the list of mods only — small, and needs Forge or a manual download to act on`
                          : status?.publishBlockedReason
                    }
                  >
                    Publish list only
                  </button>
                  {/* The one that makes a preset self-sufficient. Named for what it does
                      rather than "publish", because the difference is 40 KB versus 17.8 GB. */}
                  <button
                    className={canPublishSelected ? "primary" : ""}
                    disabled={busy || !canPublishSelected}
                    onClick={onPublishWithPayloads}
                    title={
                      !selectedPresetName
                        ? "Pick one of your presets first"
                        : status?.canPublish
                          ? `Copy every mod in "${selectedPresetName}" into the store, so it can be installed with no Forge and no downloads`
                          : status?.publishBlockedReason
                    }
                  >
                    Publish with mod files
                  </button>
                </div>
                {selectedPresetName && (
                  <span className="preset-store-note">
                    Publishing "{selectedPresetName}". Mods are stored once and shared between presets, so a second
                    preset only copies what is new.
                  </span>
                )}
                {!status?.canPublish && status?.publishBlockedReason && (
                  <span className="preset-store-warn">{status.publishBlockedReason}</span>
                )}
              </div>

              {usage && usage.payloads > 0 && (
                <div className="preset-store-usage">
                  <span>
                    {usage.payloads} mod payload(s) · {formatBytes(usage.bytes)}
                    {usage.stagingBytes > 0 ? ` · ${formatBytes(usage.stagingBytes)} part-copied` : ""}
                  </span>
                  <button
                    disabled={busy}
                    onClick={onCleanStore}
                    title="Delete payloads no preset in this store refers to any more"
                  >
                    Clean up
                  </button>
                </div>
              )}

              {(status?.entries.length ?? 0) === 0 ? (
                <p className="empty-list">Nothing published here yet.</p>
              ) : (
                <ul className="preset-store-list">
                  {status?.entries.map((entry) => (
                    <li key={entry.preset.id}>
                      <div className="preset-store-item">
                        <div className="preset-store-item-main">
                          <span className="preset-item-name">{entry.preset.name}</span>
                          <span className="preset-item-meta">
                            {entry.preset.mods.length} mods
                            {entry.preset.author ? ` · by ${entry.preset.author}` : ""}
                            {entry.preset.sptVersion ? ` · SPT ${entry.preset.sptVersion}` : ""}
                          </span>
                          {entry.preset.description && (
                            <span className="preset-item-desc">{entry.preset.description}</span>
                          )}
                          {/* A sync tool kept two copies of this preset. The newest is shown,
                              but silently picking one is how somebody ends up applying a
                              preset they did not write. */}
                          {entry.conflictsWith && (
                            <span className="preset-store-conflict">
                              {entry.conflictsWith.length} conflicting copy(ies) in the folder — showing the newest.
                            </span>
                          )}
                          {/* Whether this preset can actually set someone up, or only tell
                              them what to go and find. After Forge shuts down that is the
                              whole difference between the two. */}
                          {(() => {
                            const carried = entry.preset.mods.filter((m) => m.payload);
                            const bytes = carried.reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
                            return carried.length > 0 ? (
                              <span className="preset-store-carried">
                                carries {carried.length}/{entry.preset.mods.length} mods · {formatBytes(bytes)}
                              </span>
                            ) : (
                              <span className="preset-store-listonly">list only — no mod files</span>
                            );
                          })()}
                        </div>
                        <div className="preset-store-item-actions">
                          {entry.preset.mods.some((m) => m.payload) && (
                            <>
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() => onInstallPayloads(entry.preset.id)}
                                title="Copy this preset's mod files straight into your install — no Forge, no downloads"
                              >
                                Install mods
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => onVerifyPayloads(entry.preset.id, false)}
                                title="Check the stored files are complete. Shift-click to re-hash every byte."
                                onMouseDown={(e) => {
                                  if (e.shiftKey) {
                                    e.preventDefault();
                                    onVerifyPayloads(entry.preset.id, true);
                                  }
                                }}
                              >
                                Verify
                              </button>
                            </>
                          )}
                          <button disabled={busy} onClick={() => onImport(entry.preset.id)}>
                            Import
                          </button>
                          <button
                            disabled={busy}
                            className="preset-danger"
                            onClick={() => onUnpublish(entry.preset.id)}
                            title="Remove it from the shared folder. Your local copy is kept."
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PresetsPanel({
  presets,
  selectedId,
  report,
  busy,
  storeStatus,
  identity,
  storeUsage,
  payloadProgress,
  onSelect,
  onSaveCurrent,
  onRecapture,
  onDelete,
  onApplyState,
  onChooseStore,
  onCreateStore,
  onDisconnectStore,
  onSetIdentity,
  onSetStorePolicy,
  onPublish,
  onUnpublish,
  onImportFromStore,
  onExportFile,
  onImportFile,
  onPublishWithPayloads,
  onInstallPayloads,
  onVerifyPayloads,
  onCleanStore,
  onCancelPayloads,
  onClose
}: {
  presets: Preset[];
  selectedId: string | null;
  report: PresetReport | null;
  busy: boolean;
  storeStatus: PresetStoreStatus | null;
  identity: string;
  storeUsage: StoreUsage | null;
  payloadProgress: PayloadProgress | null;
  onSelect: (id: string) => void;
  onSaveCurrent: (name: string, description: string) => void;
  onRecapture: (id: string) => void;
  onDelete: (id: string) => void;
  onApplyState: (id: string) => void;
  onChooseStore: () => void;
  onCreateStore: (name: string, policy: WritePolicy) => void;
  onDisconnectStore: () => void;
  onSetIdentity: (name: string) => void;
  onSetStorePolicy: (policy: WritePolicy) => void;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
  onImportFromStore: (id: string) => void;
  onExportFile: (id: string) => void;
  onImportFile: () => void;
  onPublishWithPayloads: (id: string) => void;
  onInstallPayloads: (id: string) => void;
  onVerifyPayloads: (id: string, deep: boolean) => void;
  onCleanStore: () => void;
  onCancelPayloads: () => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [showAll, setShowAll] = useState(false);

  const selected = presets.find((p) => p.id === selectedId) ?? null;
  const problems = (report?.rows ?? []).filter((r) => r.issue && r.issue !== "extra");
  const visible = showAll ? report?.rows ?? [] : problems;

  return (
    <div className="preset-panel">
      <div className="preset-header">
        <div>
          <strong>Mod presets</strong>
          <span className="preset-header-note">
            A named snapshot of a working setup — save one, compare against it, or share it.
          </span>
        </div>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="preset-body">
        <div className="preset-list-col">
          <div className="preset-save">
            <input
              type="text"
              placeholder="Name this setup…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) {
                  onSaveCurrent(newName.trim(), newDescription.trim());
                  setNewName("");
                  setNewDescription("");
                }
              }}
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
            />
            <button
              className="primary"
              disabled={!newName.trim() || busy}
              onClick={() => {
                onSaveCurrent(newName.trim(), newDescription.trim());
                setNewName("");
                setNewDescription("");
              }}
            >
              Save current setup
            </button>
          </div>

          <StoreSection
            status={storeStatus}
            identity={identity}
            busy={busy}
            usage={storeUsage}
            progress={payloadProgress}
            selectedPresetName={selected?.name ?? null}
            canPublishSelected={!!selected && storeStatus?.canPublish === true}
            onChoose={onChooseStore}
            onCreate={onCreateStore}
            onDisconnect={onDisconnectStore}
            onSetIdentity={onSetIdentity}
            onSetPolicy={onSetStorePolicy}
            onPublish={() => selected && onPublish(selected.id)}
            onPublishWithPayloads={() => selected && onPublishWithPayloads(selected.id)}
            onUnpublish={onUnpublish}
            onImport={onImportFromStore}
            onInstallPayloads={onInstallPayloads}
            onVerifyPayloads={onVerifyPayloads}
            onCleanStore={onCleanStore}
            onCancelPayloads={onCancelPayloads}
            onImportFile={onImportFile}
          />

          {presets.length === 0 ? (
            <p className="empty-list">No presets yet. Save your current setup, or import one a friend sent.</p>
          ) : (
            <ul className="preset-list">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    className={`preset-item ${p.id === selectedId ? "preset-item-active" : ""}`}
                    onClick={() => onSelect(p.id)}
                  >
                    <span className="preset-item-name">{p.name}</span>
                    <span className="preset-item-meta">
                      {p.mods.length} mods
                      {(() => {
                        const off = p.mods.filter((m) => m.enabled === false).length;
                        return off > 0 ? ` (${p.mods.length - off} on, ${off} off)` : "";
                      })()}
                      {p.sptVersion ? ` · SPT ${p.sptVersion}` : ""}
                    </span>
                    {p.description && <span className="preset-item-desc">{p.description}</span>}
                    {/* Where an imported preset came from stays visible. Applying one copies
                        somebody else's idea of a correct setup onto this machine. */}
                    {p.origin && (
                      <span className="preset-item-origin" title={p.origin.path}>
                        from {p.origin.store}
                        {p.origin.author ? ` · ${p.origin.author}` : ""}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="preset-report-col">
          {!selected ? (
            <p className="empty-list">Pick a preset to compare it against this install.</p>
          ) : !report ? (
            <p className="empty-list">Comparing…</p>
          ) : (
            <>
              <div className={`preset-verdict ${report.satisfied ? "ok" : "warn"}`}>
                <strong>{report.satisfied ? "This install matches" : "Does not match yet"}</strong>
                <span>
                  {report.counts.matching} matching
                  {report.counts.missingRequired > 0 && ` · ${report.counts.missingRequired} required missing`}
                  {report.counts.versionMismatch > 0 && ` · ${report.counts.versionMismatch} wrong version`}
                  {report.counts.stateMismatch > 0 && ` · ${report.counts.stateMismatch} wrong state`}
                  {report.counts.extra > 0 && ` · ${report.counts.extra} extra`}
                </span>
              </div>

              {report.sptMatches === false && (
                <p className="preset-spt-warning">
                  This preset was captured on SPT {report.sptVersion}; this install is {report.localSptVersion}. Mods
                  built for one are not reliably safe on the other.
                </p>
              )}

              <div className="preset-actions">
                <button
                  onClick={() => onApplyState(selected.id)}
                  disabled={busy || report.counts.stateMismatch === 0}
                  className={report.counts.stateMismatch > 0 ? "primary" : ""}
                  title={
                    report.counts.stateMismatch > 0
                      ? "Switch mods on and off so they match the preset"
                      : "Nothing to switch — on/off states already match"
                  }
                >
                  {report.counts.stateMismatch > 0 ? `Fix on/off (${report.counts.stateMismatch})` : "On/off matches"}
                </button>
                <button onClick={() => onRecapture(selected.id)} disabled={busy} title="Overwrite this preset with the current install">
                  Update from install
                </button>
                <button
                  onClick={() => onExportFile(selected.id)}
                  disabled={busy}
                  title="Save this preset as a file you can send someone"
                >
                  Export file…
                </button>
                <button onClick={() => onDelete(selected.id)} disabled={busy} className="preset-danger">
                  Delete
                </button>
                <label className="preset-toggle">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                  Show all {report.rows.length}
                </label>
              </div>

              {/* Said plainly rather than discovered: Apply cannot install anything yet. */}
              {report.counts.missing > 0 && (
                <p className="preset-note">
                  {report.counts.missing} mod(s) in this preset are not installed. Presets do not carry mod files yet, so
                  install them from Forge or copy them in, then compare again.
                </p>
              )}

              {visible.length === 0 ? (
                <p className="empty-list">
                  {problems.length === 0 ? "Nothing to reconcile." : "No differences to show."}
                </p>
              ) : (
                <ul className="preset-rows">
                  {visible.map((row) => (
                    <PresetRowItem key={`${row.key}:${row.issue ?? "ok"}`} row={row} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
