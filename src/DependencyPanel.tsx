/**
 * What the mods you have are missing (v1.3.2).
 *
 * Shown after installing a mod from the catalogue, and on demand for the whole install.
 *
 * The panel only ever lists things worth acting on. A dependency you already have at a good
 * enough version is not mentioned — an earlier cut listed every declared dependency it could
 * not prove installed and produced thirteen false alarms on a healthy install, which is the
 * fastest way to make a checker not worth reading.
 */
import { DependencyReport } from "./types";

function statusLabel(r: DependencyReport): { text: string; className: string } {
  switch (r.status) {
    case "missing":
      return { text: "Not installed", className: "dep-chip-missing" };
    case "outdated":
      return { text: `Have v${r.installedVersion}, needs v${r.version}`, className: "dep-chip-outdated" };
    case "no-compatible-build":
      // Installing cannot fix this, so it must not read like the others.
      return { text: "No build for your SPT version", className: "dep-chip-blocked" };
    default:
      return { text: "Installed", className: "dep-chip-ok" };
  }
}

export function DependencyRow({
  report,
  busy,
  onInstall
}: {
  report: DependencyReport;
  busy: boolean;
  onInstall: (r: DependencyReport) => void;
}) {
  const label = statusLabel(report);
  // Only offer the button when there is something to download. "No build for your SPT" has
  // no link by construction, and a button that cannot work is worse than none.
  const actionable = (report.status === "missing" || report.status === "outdated") && !!report.downloadLink;
  return (
    <li className="dep-row">
      <div className="dep-info">
        <span className="dep-name">{report.name}</span>
        <span className={`meta-chip ${label.className}`}>{label.text}</span>
        {report.transitive && (
          <span className="meta-chip" title="Required by another dependency rather than by the mod itself">
            via {report.via}
          </span>
        )}
        {report.conflict && (
          <span
            className="meta-chip dep-chip-conflict"
            title="Your mods disagree about which version of this to use. Whichever is installed, one of them wanted a different one."
          >
            version disagreement
          </span>
        )}
      </div>
      {actionable && (
        <button className="primary" disabled={busy} onClick={() => onInstall(report)}>
          {report.status === "outdated" ? `Update to ${report.version}` : `Install ${report.version ?? ""}`}
        </button>
      )}
    </li>
  );
}

export default function DependencyPanel({
  title,
  rows,
  busy,
  note,
  onInstall,
  onInstallAll,
  onClose
}: {
  title: string;
  rows: { mod: string; reports: DependencyReport[] }[];
  busy: boolean;
  note?: string;
  onInstall: (r: DependencyReport) => void;
  onInstallAll?: (rs: DependencyReport[]) => void;
  onClose: () => void;
}) {
  // Distinct mods, because the same dependency reached from two mods is one download.
  const actionable = new Map<number, DependencyReport>();
  for (const row of rows) {
    for (const r of row.reports) {
      if ((r.status === "missing" || r.status === "outdated") && r.downloadLink && !actionable.has(r.modId)) {
        actionable.set(r.modId, r);
      }
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box dep-modal">
        <div className="modal-header">
          <strong>{title}</strong>
          <button onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {note && <p className="compare-note">{note}</p>}

        {rows.length === 0 ? (
          <p className="empty-list">Nothing missing — every mod has what it needs.</p>
        ) : (
          <>
            {onInstallAll && actionable.size > 1 && (
              <p className="update-all-row">
                <button className="primary" disabled={busy} onClick={() => onInstallAll([...actionable.values()])}>
                  Install all {actionable.size}
                </button>
                <span className="compare-note">One download each, in order.</span>
              </p>
            )}
            {rows.map((row) => (
              <div key={row.mod} className="dep-group">
                <p className="dep-group-title">{row.mod} needs:</p>
                <ul className="dep-list">
                  {row.reports.map((r) => (
                    <DependencyRow key={`${row.mod}-${r.modId}`} report={r} busy={busy} onInstall={onInstall} />
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}

        <p className="compare-note">
          Read from the catalogue's own dependency data, for the SPT version you have — so an offered build is one
          that runs on your install, never simply the newest published. Mods that declare nothing are not listed,
          and silence from the catalogue is not proof a mod is self-contained.
        </p>
      </div>
    </div>
  );
}
