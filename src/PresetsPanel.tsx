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
import { Preset, PresetReport, PresetRow } from "./types";
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

export default function PresetsPanel({
  presets,
  selectedId,
  report,
  busy,
  onSelect,
  onSaveCurrent,
  onRecapture,
  onDelete,
  onApplyState,
  onClose
}: {
  presets: Preset[];
  selectedId: string | null;
  report: PresetReport | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onSaveCurrent: (name: string, description: string) => void;
  onRecapture: (id: string) => void;
  onDelete: (id: string) => void;
  onApplyState: (id: string) => void;
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
            A named snapshot of a working setup. Saved on this machine — sharing comes next.
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

          {presets.length === 0 ? (
            <p className="empty-list">No presets yet. Save your current setup to make one.</p>
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
