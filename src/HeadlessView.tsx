/**
 * The multi-instance view: the main install, a live SPT server, and a Fika headless client,
 * side by side with the reconciliation between them.
 *
 * The three panes are deliberately NOT symmetrical, and the asymmetry is the point:
 *
 *   main      a full SPT install — client plugins AND server mods. Read/write.
 *   server    a running server somewhere on the network. It can only report the server mods
 *             it has LOADED, so no client plugins appear here and nothing is writable.
 *   headless  a Fika headless client. Being a client, it loads BepInEx/ only, so it can
 *             never hold server mods. Read/write.
 *
 * Rendering them as mirror images would report every server mod as "missing" from the
 * headless client and every client plugin as "missing" from the server, when in both cases
 * the mod cannot exist there at all. Each pane states its own scope under its title.
 *
 * Strings are literal rather than routed through i18n: this fork is English-only by design,
 * so the i18n layer is a pass-through and keys would add indirection without a language.
 */
import { useState } from "react";
import {
  HeadlessClass,
  HeadlessVerdict,
  ModInfo,
  ParityReport,
  ParityRow,
  ServerSyncReport,
  ServerSyncRow
} from "./types";
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

const SERVER_ISSUE_LABEL: Record<string, string> = {
  "missing-locally": "Install this",
  "outdated-locally": "Update this",
  "newer-locally": "Newer here",
  "not-on-server": "Not on server",
  "unknown-local-version": "Can't compare"
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

/** Chrome shared by every pane, so collapsing behaves identically across all three. */
function PaneShell({
  title,
  subtitle,
  location,
  count,
  collapsed,
  onToggleCollapse,
  headerExtra,
  children
}: {
  title: string;
  subtitle: string;
  location: string | null;
  count: number | string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <button className="hl-pane hl-pane-collapsed" onClick={onToggleCollapse} title={`Expand ${title}`}>
        <span className="hl-collapsed-title">{title}</span>
        <span className="hl-collapsed-count">{count}</span>
        <span className="hl-collapsed-hint">▸</span>
      </button>
    );
  }
  return (
    <div className="hl-pane">
      <div className="hl-pane-header">
        <div>
          <h2>
            <button className="hl-collapse-btn" onClick={onToggleCollapse} title={`Collapse ${title}`}>
              ▾
            </button>
            {title}
          </h2>
          <span className="hl-pane-sub">{subtitle}</span>
        </div>
        <span className="hl-pane-count">{count}</span>
      </div>
      <div className="hl-pane-path" title={location ?? ""}>
        {location ?? "Not configured"}
      </div>
      {headerExtra}
      {children}
    </div>
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
  showVerdicts,
  collapsed,
  onToggleCollapse,
  filtersActive
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
  collapsed: boolean;
  onToggleCollapse: () => void;
  filtersActive: boolean;
}) {
  const servers = mods.filter((m) => m.type === "server");
  const clients = mods.filter((m) => m.type !== "server");

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
    <PaneShell
      title={title}
      subtitle={subtitle}
      location={path}
      count={mods.length}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
    >
      {mods.length === 0 ? (
        <p className="empty-list">{filtersActive ? "Nothing here matches the current filters." : emptyMessage}</p>
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
    </PaneShell>
  );
}

/**
 * The live server. Read-only, and visibly so — no toggle, no remove, no override. What it
 * shows is not "the server's mod folder" but "the mods the server has loaded", which is the
 * only thing it can report about itself.
 */
function ServerPane({
  report,
  url,
  collapsed,
  onToggleCollapse,
  onChangeServer,
  onClearServer,
  query
}: {
  report: ServerSyncReport | null;
  url: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChangeServer: () => void;
  onClearServer: () => void;
  query: string;
}) {
  if (!url) {
    return (
      <PaneShell
        title="Server"
        subtitle="Not connected"
        location={null}
        count="—"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
      >
        <p className="empty-list">
          Connect to a running SPT server to see which mods it loads and what you are missing.
        </p>
        <div className="hl-pane-actions">
          <button onClick={onChangeServer} className="primary">
            Connect to a server
          </button>
        </div>
      </PaneShell>
    );
  }

  if (report && !report.reachable) {
    return (
      <PaneShell
        title="Server"
        subtitle="Unreachable"
        location={url}
        count="—"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
      >
        <p className="hl-server-error">{report.error}</p>
        <div className="hl-pane-actions">
          <button onClick={onChangeServer}>Change address</button>
          <button onClick={onClearServer}>Disconnect</button>
        </div>
      </PaneShell>
    );
  }

  const q = query.trim().toLowerCase();
  const rows = (report?.rows ?? []).filter(
    (r) => !q || r.name.toLowerCase().includes(q) || (r.serverName ?? "").toLowerCase().includes(q)
  );

  // The pane counts what the SERVER runs, not the number of rows. Rows also include local
  // mods the server does not load ("not on server"), and folding those into the headline
  // number made a 25-mod server read as 32.
  const serverModCount = (report?.rows ?? []).filter((r) => r.issue !== "not-on-server").length;

  const renderRow = (row: ServerSyncRow) => (
    <li key={row.key} className={`hl-row ${row.issue ? `hl-issue-server-${row.issue}` : ""}`}>
      <div className="hl-row-main">
        <span className="hl-name" title={[row.guid && `GUID: ${row.guid}`, row.serverName && `Server calls it: ${row.serverName}`].filter(Boolean).join("\n")}>
          {row.name}
        </span>
        <span className="hl-version">{row.serverVersion ?? "—"}</span>
      </div>
      <div className="hl-row-meta">
        {row.issue && (
          <span className={`hl-issue hl-issue-tag-server-${row.issue}`} title={row.detail ?? ""}>
            {SERVER_ISSUE_LABEL[row.issue] ?? row.issue}
          </span>
        )}
        {row.localVersion && row.serverVersion && row.localVersion !== row.serverVersion && (
          <span className="hl-server-versions">
            you {row.localVersion} → {row.serverVersion}
          </span>
        )}
        {/* A name match is weaker than a GUID match and says so, rather than being
            presented with the same confidence. */}
        {row.matchedBy === "name" && (
          <span className="hl-badge hl-unknown" title="Matched by name, not GUID — worth confirming.">
            name match<em className="hl-guess">?</em>
          </span>
        )}
        {row.url && (
          <a className="hl-server-src" href={row.url} target="_blank" rel="noreferrer" title={row.url}>
            source
          </a>
        )}
      </div>
    </li>
  );

  const counts = report?.counts;

  return (
    <PaneShell
      title="Server"
      subtitle="Loaded server mods — read only"
      location={url}
      count={report ? serverModCount : "…"}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      headerExtra={
        report ? (
          <div className={`hl-server-status ${report.readyToPlay ? "ok" : "warn"}`}>
            <strong>{report.readyToPlay ? "Ready to play" : "Not ready"}</strong>
            <span>
              SPT {report.sptVersion ?? "?"}
              {report.sptMatches === false && <em className="hl-spt-mismatch"> ≠ yours ({report.localSptVersion})</em>}
            </span>
          </div>
        ) : undefined
      }
    >
      {counts && (
        <ul className="hl-server-counts">
          {counts.needInstalling > 0 && <li className="bad">{counts.needInstalling} to install</li>}
          {counts.needUpdating > 0 && <li className="bad">{counts.needUpdating} to update</li>}
          {counts.unknownVersion > 0 && <li>{counts.unknownVersion} can't compare</li>}
          {counts.newerLocally > 0 && <li className="warn">{counts.newerLocally} newer here</li>}
          {counts.notOnServer > 0 && <li className="warn">{counts.notOnServer} not on server</li>}
          <li className="ok">{counts.inSync} in sync</li>
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="empty-list">{query ? "Nothing here matches the search." : "No server mods reported."}</p>
      ) : (
        <div className="hl-pane-body">
          <h3 className="hl-group-title">
            Server mods <span>loaded</span> ({rows.length})
          </h3>
          <ul className="hl-list">{rows.map(renderRow)}</ul>
        </div>
      )}

      {report && report.fikaRequired.length === 0 && (
        <p className="hl-gutter-note">
          This server declares no required client plugins, so client-side parity cannot be checked against it. The host
          sets that in <code>fika.jsonc</code> under <code>client.mods.required</code>.
        </p>
      )}

      <div className="hl-pane-actions">
        <button onClick={onChangeServer}>Change address</button>
        <button onClick={onClearServer}>Disconnect</button>
      </div>
    </PaneShell>
  );
}

/** The break down the middle: what the two local instances do and do not agree on. */
function ParityGutter({ parity }: { parity: ParityReport | null }) {
  if (!parity) {
    return (
      <div className="hl-gutter">
        <div className="hl-gutter-title">Parity</div>
        <p className="hl-gutter-note">Link a headless client to compare it against the main install.</p>
      </div>
    );
  }

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
        <li>
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

export default function InstancesView({
  mainPath,
  headlessPath,
  mainMods,
  headlessMods,
  parity,
  server,
  serverUrl,
  filtersActive,
  overrides,
  onOverride,
  onToggle,
  onUninstall,
  onOpenFolder,
  onChangeHeadless,
  onChangeServer,
  onClearServer,
  onExitMultiMode,
  onRefresh,
  refreshing,
  searchQuery
}: {
  mainPath: string | null;
  headlessPath: string | null;
  mainMods: ModInfo[];
  headlessMods: ModInfo[];
  parity: ParityReport | null;
  server: ServerSyncReport | null;
  serverUrl: string | null;
  filtersActive: boolean;
  overrides: Record<string, HeadlessClass>;
  onOverride: (key: string, klass: HeadlessClass | null) => void;
  onToggle: (mod: ModInfo, target: "main" | "headless") => void;
  onUninstall: (mod: ModInfo, target: "main" | "headless") => void;
  onOpenFolder: (mod: ModInfo, target: "main" | "headless") => void;
  onChangeHeadless: () => void;
  onChangeServer: () => void;
  onClearServer: () => void;
  onExitMultiMode: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** The shared search box. Applied to the server pane too — it has its own row shape, so
      it cannot go through applyFilterSort with the local panes. */
  searchQuery: string;
}) {
  // Collapsed panes are remembered per session so a chosen comparison stays put across a
  // rescan. Server starts collapsed when nothing is connected — an empty invitation should
  // not cost a third of the width.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ server: !serverUrl });
  const toggle = (k: string) => setCollapsed((prev) => ({ ...prev, [k]: !prev[k] }));

  const rowsByKey = new Map((parity?.rows ?? []).map((r) => [r.key, r]));
  const openCount = ["main", "server", "headless"].filter((k) => !collapsed[k]).length;

  return (
    <div className="hl-wrapper">
      <div className="hl-toolbar">
        <strong>Instances</strong>
        <span className="hl-toolbar-note">
          Main install{serverUrl ? ", live server" : ""}
          {headlessPath ? ", Fika headless client" : ""} — filters and search above apply to every pane.
        </span>
        <div className="hl-toolbar-actions">
          <button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Rescanning…" : "Rescan all"}
          </button>
          <button onClick={onChangeServer}>{serverUrl ? "Change server" : "Add server"}</button>
          <button onClick={onChangeHeadless}>{headlessPath ? "Change headless" : "Add headless"}</button>
          <button onClick={onExitMultiMode}>Single view</button>
        </div>
      </div>

      <div className={`hl-split hl-open-${openCount}`}>
        <InstancePane
          title="Main install"
          subtitle="Client + server — this machine"
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
          collapsed={!!collapsed.main}
          onToggleCollapse={() => toggle("main")}
          filtersActive={filtersActive}
        />

        <ServerPane
          report={server}
          url={serverUrl}
          collapsed={!!collapsed.server}
          onToggleCollapse={() => toggle("server")}
          onChangeServer={onChangeServer}
          onClearServer={onClearServer}
          query={searchQuery}
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
          collapsed={!!collapsed.headless}
          onToggleCollapse={() => toggle("headless")}
          filtersActive={filtersActive}
        />
      </div>
    </div>
  );
}
