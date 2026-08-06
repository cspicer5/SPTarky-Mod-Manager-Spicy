/**
 * The dual-instance view: the main SPT install on the left, the Fika headless client on the
 * right, and the reconciliation between them down the middle.
 *
 * The asymmetry between the two panes is deliberate and load-bearing. A headless client is
 * a CLIENT — it loads BepInEx/ and nothing else — so the right-hand pane can never show
 * server mods. Rendering the two sides as mirror images would imply the ~26 server mods in a
 * typical install are "missing" from the headless side, when in fact they cannot exist
 * there. The gutter is where that distinction is made visible.
 *
 * Strings are literal rather than routed through i18n: this fork is English-only by design,
 * so the i18n layer is a pass-through and keys would add indirection without adding a
 * language.
 */
import { useState } from "react";
import { HeadlessClass, HeadlessVerdict, ModInfo, ParityReport, ParityRow } from "./types";
import "./headless.css";

/**
 * Must stay identical to parityKey() in electron/headless.ts. Scoping by side is what stops
 * a mod that ships a server half and a client half under one folder name (several do) from
 * collapsing into a single row, where one half inherits the other's verdict.
 */
function parityKey(mod: ModInfo): string {
  return `${mod.type === "server" ? "server" : "client"}:${mod.id.trim().toLowerCase().replace(/\.dll$/, "").replace(/^\d+[-_.\s]+/, "")}`;
}

const CLASS_LABEL: Record<HeadlessClass, string> = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
  unnecessary: "Not needed",
  unknown: "Undecided",
  "server-only": "Server only"
};

/** What the verdict rests on, in the user's words. A guess must read as a guess. */
const SOURCE_LABEL: Record<string, string> = {
  manual: "your choice",
  structural: "how SPT loads mods",
  rule: "Fika's guidance",
  pairing: "server half installed",
  category: "guessed from category",
  none: "no guidance"
};

const ISSUE_LABEL: Record<string, string> = {
  "missing-required": "Missing — required",
  "version-drift": "Version mismatch",
  "missing-recommended": "Missing on headless",
  "server-mod-in-headless": "Never loads here",
  "unnecessary-menu-risk": "Patches menus",
  "headless-only": "Only on headless"
};

function VerdictBadge({ verdict }: { verdict: HeadlessVerdict }) {
  return (
    <span
      className={`hl-badge hl-${verdict.klass}`}
      title={`${verdict.why}\n\nBasis: ${SOURCE_LABEL[verdict.source] ?? verdict.source}`}
    >
      {CLASS_LABEL[verdict.klass]}
      {/* Anything weaker than a documented rule is marked, so an inference never reads as a
          fact. Same principle as the Forge matcher's "needs confirmation". */}
      {(verdict.source === "category" || verdict.source === "none") && <em className="hl-guess">?</em>}
    </span>
  );
}

function OverrideMenu({
  value,
  onChange
}: {
  value: HeadlessClass | undefined;
  onChange: (klass: HeadlessClass | null) => void;
}) {
  return (
    <select
      className="hl-override"
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as HeadlessClass | null)}
      title="Override this classification. Your choice outranks every rule."
    >
      <option value="">Auto</option>
      <option value="required">Required</option>
      <option value="recommended">Recommended</option>
      <option value="optional">Optional</option>
      <option value="unnecessary">Not needed</option>
    </select>
  );
}

function InstancePane({
  title,
  subtitle,
  path,
  mods,
  rowsByKey,
  overrides,
  onOverride,
  onToggle,
  onUninstall,
  onOpenFolder,
  emptyMessage,
  showVerdicts
}: {
  title: string;
  subtitle: string;
  path: string | null;
  mods: ModInfo[];
  rowsByKey: Map<string, ParityRow>;
  overrides: Record<string, HeadlessClass>;
  onOverride: (key: string, klass: HeadlessClass | null) => void;
  onToggle: (mod: ModInfo) => void;
  onUninstall: (mod: ModInfo) => void;
  onOpenFolder: (mod: ModInfo) => void;
  emptyMessage: string;
  showVerdicts: boolean;
}) {
  const [query, setQuery] = useState("");
  const visible = query
    ? mods.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
    : mods;

  const servers = visible.filter((m) => m.type === "server");
  const clients = visible.filter((m) => m.type !== "server");

  const renderRow = (mod: ModInfo) => {
    const row = rowsByKey.get(parityKey(mod));
    const issue = row?.issue;
    return (
      <li key={`${mod.type}:${mod.id}`} className={`hl-row ${mod.enabled ? "" : "disabled"} ${issue ? `hl-issue-${issue}` : ""}`}>
        {/* Actions live on the title line, not with the badges. When they shared a row with
            a badge plus an issue tag plus the override select, the group wrapped and rows
            with problems became twice as tall as rows without — the list read as ragged
            exactly where it most needed to be scannable. */}
        <div className="hl-row-main">
          <span className="hl-name" title={mod.id}>
            {mod.name}
          </span>
          <span className="hl-version">{mod.version ?? "—"}</span>
          <div className="hl-row-actions">
            <button onClick={() => onToggle(mod)} title={mod.enabled ? "Disable" : "Enable"}>
              {mod.enabled ? "On" : "Off"}
            </button>
            <button onClick={() => onOpenFolder(mod)} title="Open folder">
              ⁝
            </button>
            <button onClick={() => onUninstall(mod)} title="Remove" className="hl-danger">
              ✕
            </button>
          </div>
        </div>
        <div className="hl-row-meta">
          {showVerdicts && row && <VerdictBadge verdict={row.verdict} />}
          {issue && (
            <span className={`hl-issue hl-issue-tag-${issue}`} title={row?.detail ?? ""}>
              {ISSUE_LABEL[issue] ?? issue}
            </span>
          )}
          {/* Overrides are keyed by the mod, not the side: saying "SAIN is required" is a
              statement about SAIN, and the backend looks it up by plain name. */}
          {showVerdicts && row && row.verdict.klass !== "server-only" && (
            <OverrideMenu value={overrides[row.modKey]} onChange={(klass) => onOverride(row.modKey, klass)} />
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="hl-pane">
      <div className="hl-pane-header">
        <div>
          <h2>{title}</h2>
          <span className="hl-pane-sub">{subtitle}</span>
        </div>
        <span className="hl-pane-count">{mods.length}</span>
      </div>
      <div className="hl-pane-path" title={path ?? ""}>
        {path ?? "Not configured"}
      </div>

      <input
        className="hl-search"
        type="text"
        placeholder="Filter…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {mods.length === 0 ? (
        <p className="empty-list">{emptyMessage}</p>
      ) : (
        <div className="hl-pane-body">
          <h3 className="hl-group-title">
            Client plugins <span>BepInEx/plugins</span> ({clients.length})
          </h3>
          <ul className="hl-list">{clients.map(renderRow)}</ul>

          {servers.length > 0 && (
            <>
              <h3 className="hl-group-title">
                Server mods <span>user/mods</span> ({servers.length})
              </h3>
              <ul className="hl-list">{servers.map(renderRow)}</ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The break down the middle: what the two sides do and do not agree on. */
function ParityGutter({ parity }: { parity: ParityReport }) {
  const { counts } = parity;
  const problems = parity.rows.filter((r) => r.issue && r.issue !== "headless-only");

  return (
    <div className="hl-gutter">
      <div className="hl-gutter-title">Parity</div>

      <ul className="hl-gutter-counts">
        <li className={counts.aligned ? "ok" : ""}>
          <strong>{counts.aligned}</strong> aligned
        </li>
        <li className={counts.missingOnHeadless ? "warn" : ""}>
          <strong>{counts.missingOnHeadless}</strong> missing
        </li>
        <li className={counts.versionDrift ? "bad" : ""}>
          <strong>{counts.versionDrift}</strong> drift
        </li>
        <li className={counts.headlessOnly ? "warn" : ""}>
          <strong>{counts.headlessOnly}</strong> extra
        </li>
        <li className={counts.needsReview ? "" : ""}>
          <strong>{counts.needsReview}</strong> to review
        </li>
      </ul>

      {problems.length === 0 ? (
        <p className="hl-gutter-clear">
          Nothing to reconcile. Every mod that changes raid behaviour is present on both sides at the same version.
        </p>
      ) : (
        <ol className="hl-gutter-list">
          {problems.slice(0, 12).map((row) => (
            <li key={row.key} className={`hl-gutter-item hl-issue-tag-${row.issue}`} title={row.detail ?? ""}>
              <span className="hl-gutter-issue">{ISSUE_LABEL[row.issue!] ?? row.issue}</span>
              <span className="hl-gutter-name">{row.name}</span>
              {row.issue === "version-drift" && (
                <span className="hl-gutter-versions">
                  {row.mainVersion} → {row.headlessVersion}
                </span>
              )}
            </li>
          ))}
          {problems.length > 12 && <li className="hl-gutter-more">+{problems.length - 12} more</li>}
        </ol>
      )}

      <p className="hl-gutter-note">
        The headless client is the raid host and is authoritative on AI and inventory, so anything that changes in-raid
        behaviour must match on both sides. Display-only and stash-only mods do not need to.
      </p>
    </div>
  );
}

export default function HeadlessView({
  mainPath,
  headlessPath,
  mainMods,
  headlessMods,
  parity,
  overrides,
  onOverride,
  onToggle,
  onUninstall,
  onOpenFolder,
  onChangeHeadless,
  onDisableDualMode,
  onRefresh
}: {
  mainPath: string | null;
  headlessPath: string | null;
  mainMods: ModInfo[];
  headlessMods: ModInfo[];
  parity: ParityReport;
  overrides: Record<string, HeadlessClass>;
  onOverride: (key: string, klass: HeadlessClass | null) => void;
  onToggle: (mod: ModInfo, target: "main" | "headless") => void;
  onUninstall: (mod: ModInfo, target: "main" | "headless") => void;
  onOpenFolder: (mod: ModInfo, target: "main" | "headless") => void;
  onChangeHeadless: () => void;
  onDisableDualMode: () => void;
  onRefresh: () => void;
}) {
  const rowsByKey = new Map(parity.rows.map((r) => [r.key, r]));

  return (
    <div className="hl-wrapper">
      <div className="hl-toolbar">
        <strong>Dual instance</strong>
        <span className="hl-toolbar-note">Main install and Fika headless client, side by side.</span>
        <div className="hl-toolbar-actions">
          <button onClick={onRefresh}>Rescan both</button>
          <button onClick={onChangeHeadless}>Change headless folder</button>
          <button onClick={onDisableDualMode}>Exit dual view</button>
        </div>
      </div>

      <div className="hl-split">
        <InstancePane
          title="Main install"
          subtitle="Client + server"
          path={mainPath}
          mods={mainMods}
          rowsByKey={rowsByKey}
          overrides={overrides}
          onOverride={onOverride}
          onToggle={(m) => onToggle(m, "main")}
          onUninstall={(m) => onUninstall(m, "main")}
          onOpenFolder={(m) => onOpenFolder(m, "main")}
          emptyMessage="No mods found in the main install."
          showVerdicts
        />

        <ParityGutter parity={parity} />

        <InstancePane
          title="Headless client"
          subtitle="Client only — shares the main server"
          path={headlessPath}
          mods={headlessMods}
          rowsByKey={rowsByKey}
          overrides={overrides}
          onOverride={onOverride}
          onToggle={(m) => onToggle(m, "headless")}
          onUninstall={(m) => onUninstall(m, "headless")}
          onOpenFolder={(m) => onOpenFolder(m, "headless")}
          emptyMessage="No plugins installed on the headless client yet."
          showVerdicts={false}
        />
      </div>
    </div>
  );
}
