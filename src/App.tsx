import { useEffect, useState, useCallback, useMemo, useRef, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  ModInfo,
  ModType,
  ConflictReport,
  ForgeUpdateCheckResult,
  ForgeSptVersion,
  ForgeStatusCacheEntry,
  ForgeCatalogMod,
  ForgeCategory,
  InstallResult,
  AppUpdateInfo,
  AppRelease,
  HeadlessClass,
  HeadlessView as HeadlessViewData,
  InstanceId,
  ServerSyncReport,
  ServerSyncRow,
  Preset,
  PresetReport,
  PresetStoreStatus,
  PayloadProgress,
  StoreUsage,
  WritePolicy,
  AddonSuggestion,
  AddonLink,
  AddonIntegration,
  BulkReinstallProgress,
  BulkReinstallOutcome
} from "./types";
import { Lang, translate, translateBackendMessage } from "./i18n";
import InstancesView from "./HeadlessView";
import PresetsPanel from "./PresetsPanel";
import AddonsPanel from "./AddonsPanel";


interface Toast {
  id: number;
  text: string;
  ok: boolean;
}

type TypeFilter = "all" | ModType;
type StatusFilter = "all" | "enabled" | "disabled";
type OriginFilter = "all" | "manual" | "manager";
type SortField = "name" | "status" | "origin" | "installedAt" | "forge";
type SortDirection = "asc" | "desc";

/**
 * Identity of a ROW, not of a mod.
 *
 * The enabled flag is part of it because the same mod can legitimately appear twice — an
 * enabled copy in plugins/ and a stale disabled one in plugins.disabled/, which is what a
 * reinstall used to leave behind. With `type:id` alone both rows shared one key, so
 * selecting either selected both, neither could be deselected, and package counting saw
 * four parts where there were two.
 */
function selectionKey(mod: ModInfo): string {
  return `${mod.type}:${mod.enabled ? "on" : "off"}:${mod.id}`;
}

/** Numeric semver comparison, so 0.10.0 sorts above 0.9.0 as it should. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function ToastStack({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.ok ? "toast-ok" : "toast-error"}`}>
          {t.ok ? "✔ " : "❌ "}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  // English-only fork: no picker, nothing to persist. Kept as a named constant rather
  // than inlined so every translate()/t()/tMsg() call site stays untouched.
  const lang: Lang = "en";
  // Relink dialog state — see relinkForgeMatch for why this is not window.prompt().
  const [relinkTarget, setRelinkTarget] = useState<{ originalName: string; displayName: string } | null>(null);
  const [relinkInput, setRelinkInput] = useState("");
  function t(key: string, vars?: Record<string, string | number>): string {
    return translate(lang, key, vars);
  }
  function tMsg(msg: string | undefined | null): string {
    return translateBackendMessage(msg, lang);
  }

  const [sptPath, setSptPath] = useState<string | null>(null);
  const [serverRoot, setServerRoot] = useState<string | null>(null);
  const [isSplitInstance, setIsSplitInstance] = useState(false);
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);
  const [compareResult, setCompareResult] = useState<{ missing: string[]; extra: string[] } | null>(null);
  const [sptVersion, setSptVersion] = useState<string | undefined>(undefined);
  const [conflictReport, setConflictReport] = useState<ConflictReport | null>(null);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [sptVersionInput, setSptVersionInput] = useState("");
  const [forgeResult, setForgeResult] = useState<ForgeUpdateCheckResult | null>(null);
  const [checkingForgeUpdates, setCheckingForgeUpdates] = useState(false);
  const [forgeError, setForgeError] = useState<string | null>(null);
  const [forgeStatusByName, setForgeStatusByName] = useState<
    Map<string, { status: "update" | "blocked" | "incompatible" | "info"; version?: string }>
  >(new Map());
  const [forgeSptVersions, setForgeSptVersions] = useState<ForgeSptVersion[]>([]);
  const [forgeCheckedAt, setForgeCheckedAt] = useState<string | null>(null);

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseCategory, setBrowseCategory] = useState("");
  const [browseCategories, setBrowseCategories] = useState<ForgeCategory[]>([]);
  const [browseOnlyCompatible, setBrowseOnlyCompatible] = useState(false);
  const [browseResults, setBrowseResults] = useState<ForgeCatalogMod[]>([]);
  const [browsePage, setBrowsePage] = useState(1);
  const [browseLastPage, setBrowseLastPage] = useState(1);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedVersionByModId, setSelectedVersionByModId] = useState<Map<number, number>>(new Map());
  const [installingModId, setInstallingModId] = useState<number | null>(null);

  interface QueueItem {
    id: string;
    name: string;
    status: "queued" | "active" | "done" | "error";
    receivedBytes?: number;
    totalBytes?: number;
    startedAt?: number;
    message?: string;
  }
  const [downloadQueue, setDownloadQueue] = useState<QueueItem[]>([]);

  // Update check for the app itself — runs once at startup. Notifies only; downloading
  // and installing remain the person's decision (and action), in their browser.
  const [forgeProgress, setForgeProgress] = useState<{ done: number; total: number } | null>(null);
  const [lookupInProgress, setLookupInProgress] = useState(false);
  const [installProgress, setInstallProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    const unsubscribe = window.modManagerAPI.onForgeCheckProgress(setForgeProgress);
    return unsubscribe;
  }, []);

  /* --- updating the app itself --------------------------------------------
   * A version list rather than just "update to latest", so a bad release can be stepped
   * back from without hunting for a zip. Downgrading is an explicit choice, not the default.
   */
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const [appReleases, setAppReleases] = useState<AppRelease[]>([]);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [selectedRelease, setSelectedRelease] = useState<string>("");
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [installingApp, setInstallingApp] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{ received: number; total: number } | null>(null);

  useEffect(() => {
    const unsubscribe = window.modManagerAPI.onAppUpdateProgress(setUpdateProgress);
    return unsubscribe;
  }, []);

  async function openUpdatePanel() {
    setUpdatePanelOpen(true);
    setLoadingReleases(true);
    setReleasesError(null);
    try {
      const { releases, error } = await window.modManagerAPI.listAppReleases();
      setAppReleases(releases);
      setReleasesError(error ?? null);
      // Defaults to the newest release that is not the one already running.
      const newest = releases.find((r) => !r.prerelease) ?? releases[0];
      setSelectedRelease(newest?.tag ?? "");
    } finally {
      setLoadingReleases(false);
    }
  }

  async function handleInstallAppRelease() {
    const release = appReleases.find((r) => r.tag === selectedRelease);
    if (!release) return;
    const older = release.isCurrent
      ? "reinstall the version you are already running"
      : compareSemver(release.version, appVersionRunning) < 0
        ? `go BACK to ${release.version} from ${appVersionRunning}`
        : `update to ${release.version}`;
    if (
      !window.confirm(
        `This will ${older}.\n\n` +
          "The app closes, swaps itself over, and reopens. Your current version is kept as a backup and restored " +
          "automatically if the new one fails to start.\n\nYour settings and mods are not touched."
      )
    ) {
      return;
    }
    setInstallingApp(true);
    setUpdateProgress(null);
    const result = await window.modManagerAPI.installAppRelease(release.tag);
    pushToast(result.message, result.success);
    if (!result.success) {
      setInstallingApp(false);
      setUpdateProgress(null);
    }
    // On success the app is about to quit; leave the button spinning.
  }

  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    window.modManagerAPI.checkAppUpdate().then(setAppUpdate);
  }, []);
  const appVersionRunning = appUpdate?.currentVersion ?? "";

  useEffect(() => {
    const unsubscribe = window.modManagerAPI.onDownloadProgress(({ jobId, receivedBytes, totalBytes }) => {
      setDownloadQueue((prev) => prev.map((q) => (q.id === jobId ? { ...q, receivedBytes, totalBytes } : q)));
    });
    return unsubscribe;
  }, []);

  function pushQueueItem(name: string): string {
    const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDownloadQueue((prev) => [...prev, { id, name, status: "queued" }]);
    return id;
  }
  function markQueueActive(id: string) {
    setDownloadQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: "active", startedAt: Date.now() } : q)));
  }
  function markQueueDone(id: string, success: boolean, message?: string) {
    setDownloadQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: success ? "done" : "error", message } : q)));
    // Removes itself from the list after a while, with no manual action needed — errors
    // stay visible a little longer than successes, being more likely worth reading.
    setTimeout(
      () => {
        setDownloadQueue((prev) => prev.filter((q) => q.id !== id));
      },
      success ? 3000 : 6000
    );
  }
  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const pushToast = useCallback((text: string, ok: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text, ok }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const refreshMods = useCallback(async () => {
    const list = await window.modManagerAPI.scanMods();
    setMods(list);
    return list;
  }, []);

  /* --- multi-instance: main + live server + Fika headless -------------------
   * Entered deliberately, and only once there is a second instance to show. An SPT setup
   * with neither a headless client nor a server is the normal case, and the split view
   * would be a confusing empty half for everyone in it.
   */
  const [headlessPath, setHeadlessPath] = useState<string | null>(null);
  const [multiMode, setMultiMode] = useState(false);
  const [headlessData, setHeadlessData] = useState<HeadlessViewData | null>(null);
  const [headlessOverrides, setHeadlessOverrides] = useState<Record<string, HeadlessClass>>({});
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [serverSync, setServerSync] = useState<ServerSyncReport | null>(null);
  const [serverPrompt, setServerPrompt] = useState(false);
  const [serverInput, setServerInput] = useState("");
  const [multiRefreshing, setMultiRefreshing] = useState(false);

  useEffect(() => {
    window.modManagerAPI.getHeadlessPath().then(setHeadlessPath);
    window.modManagerAPI.getServerUrl().then(setServerUrl);
  }, []);

  const refreshHeadless = useCallback(async () => {
    const view = await window.modManagerAPI.getHeadlessView();
    setHeadlessData(view.configured ? view : null);
    if (view.configured && view.headlessPath) setHeadlessPath(view.headlessPath);
    return view;
  }, []);

  const refreshServer = useCallback(async () => {
    const result = await window.modManagerAPI.getServerSync();
    setServerSync(result.configured ? result.report ?? null : null);
  }, []);

  // Both sides refresh together so the panes can never show two different scans of the
  // world — the same reason getHeadlessView returns both mod lists in one call.
  const refreshMulti = useCallback(async () => {
    setMultiRefreshing(true);
    try {
      await Promise.all([refreshHeadless(), refreshServer()]);
    } finally {
      setMultiRefreshing(false);
    }
  }, [refreshHeadless, refreshServer]);

  useEffect(() => {
    if (multiMode) void refreshMulti();
  }, [multiMode, refreshMulti]);

  async function handleSelectHeadlessFolder() {
    const result = await window.modManagerAPI.selectHeadlessFolder();
    if (!result.success) {
      if (result.message) pushToast(result.message, false);
      return;
    }
    setHeadlessPath(result.path ?? null);
    setMultiMode(true);
    await refreshMulti();
    pushToast(result.message ?? "Headless client linked.", true);
  }

  async function submitServerUrl() {
    const value = serverInput.trim();
    if (!value) return;
    const result = await window.modManagerAPI.setServerUrl(value);
    pushToast(result.message ?? (result.success ? "Server linked." : "Couldn't reach that server."), result.success);
    if (!result.success) return;
    setServerUrl(result.url ?? value);
    setServerPrompt(false);
    setServerInput("");
    setMultiMode(true);
    await refreshMulti();
  }

  async function handleClearServer() {
    await window.modManagerAPI.clearServerUrl();
    setServerUrl(null);
    setServerSync(null);
    pushToast("Server disconnected.", true);
  }

  // Each button opens its own picker when nothing is configured, rather than showing an
  // empty pane and leaving the user to work out what to do with it.
  function handleServerButton() {
    if (!serverUrl) {
      setServerPrompt(true);
      return;
    }
    setMultiMode(true);
  }

  async function handleHeadlessButton() {
    if (!headlessPath) {
      await handleSelectHeadlessFolder();
      return;
    }
    setMultiMode(true);
  }

  async function handleHeadlessOverride(key: string, klass: HeadlessClass | null) {
    setHeadlessOverrides((prev) => {
      const next = { ...prev };
      if (klass) next[key] = klass;
      else delete next[key];
      return next;
    });
    await window.modManagerAPI.setHeadlessOverride(key, klass);
    await refreshHeadless();
  }

  async function handleInstanceToggle(mod: ModInfo, target: InstanceId) {
    const result = await window.modManagerAPI.toggleMod(mod, target);
    pushToast(tMsg(result.message), result.success);
    await refreshHeadless();
    if (target === "main") await refreshMods();
  }

  async function handleInstanceUninstall(mod: ModInfo, target: InstanceId) {
    const where = target === "headless" ? "the headless client" : "the main install";
    if (!window.confirm(`Remove "${mod.name}" from ${where}?`)) return;
    const result = await window.modManagerAPI.uninstallMod(mod, target);
    pushToast(tMsg(result.message), result.success);
    await refreshHeadless();
    if (target === "main") await refreshMods();
  }

  // The server pane has no equivalent of these. It is remote and read-only by design, so
  // there is no toggle, no removal and no install target — see electron/sptServer.ts.

  const [syncing, setSyncing] = useState(false);
  const [installingFromServer, setInstallingFromServer] = useState<string | null>(null);

  /* --- bulk reinstall ------------------------------------------------------- */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPreview, setBulkPreview] = useState<{
    modCount?: number;
    withoutRecord?: number;
    withRepo?: number;
    configDirs?: number;
    sptVersion?: string;
  } | null>(null);
  const [bulkSource, setBulkSource] = useState<"forge" | "github">("forge");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkReinstallProgress | null>(null);
  const [bulkResult, setBulkResult] = useState<{
    message: string;
    outcomes?: BulkReinstallOutcome[];
    counts?: { reinstalled: number; notFound: number; failed: number; skipped: number } | null;
  } | null>(null);
  const [bulkConfirmText, setBulkConfirmText] = useState("");

  useEffect(() => {
    const unsubscribe = window.modManagerAPI.onBulkReinstallProgress(setBulkProgress);
    return unsubscribe;
  }, []);

  async function openBulkReinstall() {
    setBulkOpen(true);
    setBulkResult(null);
    setBulkConfirmText("");
    setBulkPreview(null);
    const preview = await window.modManagerAPI.previewBulkReinstall();
    if (!preview.success) {
      pushToast(preview.message ?? "Couldn't check the install.", false);
      setBulkOpen(false);
      return;
    }
    setBulkPreview(preview);
  }

  // Typing the word is deliberate friction. This re-downloads every mod over a working
  // install, and the source it downloads from disappears on 2026-08-10.
  async function runBulkReinstall() {
    setBulkRunning(true);
    setBulkResult(null);
    setBulkProgress(null);
    try {
      const result = await window.modManagerAPI.runBulkReinstall({
        sptVersion: bulkPreview?.sptVersion,
        source: bulkSource
      });
      setBulkResult({ message: result.message, outcomes: result.outcomes, counts: result.counts });
      pushToast(result.message, result.success);
      await refreshMods();
    } finally {
      setBulkRunning(false);
      setBulkProgress(null);
    }
  }

  /* --- mod presets (phase 1: local) ---------------------------------------- */
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presetReport, setPresetReport] = useState<PresetReport | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);

  const refreshPresets = useCallback(async () => {
    setPresets(await window.modManagerAPI.listPresets());
  }, []);

  const loadPresetReport = useCallback(async (id: string) => {
    setPresetReport(null);
    const result = await window.modManagerAPI.getPresetReport(id);
    setPresetReport(result.success ? result.report ?? null : null);
    if (!result.success && result.message) pushToast(result.message, false);
  }, []);

  async function openPresets() {
    setPresetsOpen(true);
    await Promise.all([refreshPresets(), refreshStore()]);
  }

  async function handleSelectPreset(id: string) {
    setSelectedPresetId(id);
    await loadPresetReport(id);
  }

  async function handleSavePreset(name: string, description: string) {
    setPresetBusy(true);
    try {
      const result = await window.modManagerAPI.createPreset({ name, description });
      pushToast(result.message ?? (result.success ? "Preset saved." : "Couldn't save."), result.success);
      if (result.success && result.preset) {
        await refreshPresets();
        await handleSelectPreset(result.preset.id);
      }
    } finally {
      setPresetBusy(false);
    }
  }

  async function handleRecapturePreset(id: string) {
    const preset = presets.find((p) => p.id === id);
    if (!window.confirm(`Overwrite "${preset?.name ?? id}" with the current install?\n\nThe preset's description and optional flags are kept.`)) return;
    setPresetBusy(true);
    try {
      const result = await window.modManagerAPI.updatePreset(id);
      pushToast(result.message ?? "Updated.", result.success);
      await refreshPresets();
      await loadPresetReport(id);
    } finally {
      setPresetBusy(false);
    }
  }

  async function handleDeletePreset(id: string) {
    const preset = presets.find((p) => p.id === id);
    if (!window.confirm(`Delete the preset "${preset?.name ?? id}"?\n\nYour mods are not touched.`)) return;
    const result = await window.modManagerAPI.deletePreset(id);
    pushToast(result.message, result.success);
    if (result.success) {
      setSelectedPresetId(null);
      setPresetReport(null);
      await refreshPresets();
    }
  }

  // Only switches mods on and off. It cannot install anything — the panel says so, rather
  // than leaving the user to discover that "apply" did less than the word implies.
  async function handleApplyPresetState(id: string) {
    setPresetBusy(true);
    try {
      const result = await window.modManagerAPI.applyPresetState(id);
      pushToast(tMsg(result.message), result.success);
      await refreshMods();
      await loadPresetReport(id);
    } finally {
      setPresetBusy(false);
    }
  }

  /* --- addons: compatibility and companion mods (v1.2.2) --------------------
   * Two halves with different lifetimes: the catalogue is frozen at the shutdown, while
   * reading the installed assemblies keeps working forever. The panel says which is which.
   */
  const [addonsOpen, setAddonsOpen] = useState(false);
  const [addonSuggestions, setAddonSuggestions] = useState<AddonSuggestion[]>([]);
  const [addonLinks, setAddonLinks] = useState<AddonLink[]>([]);
  const [addonIntegrations, setAddonIntegrations] = useState<AddonIntegration[]>([]);
  const [addonCatalogueSize, setAddonCatalogueSize] = useState(0);
  const [addonsScanned, setAddonsScanned] = useState(false);
  const [addonBusy, setAddonBusy] = useState(false);

  const refreshAddonSuggestions = useCallback(async () => {
    const result = await window.modManagerAPI.getAddonSuggestions();
    if (result.success) {
      setAddonSuggestions(result.suggestions ?? []);
      setAddonCatalogueSize(result.catalogueSize ?? 0);
    } else if (result.message) {
      pushToast(result.message, false);
    }
  }, []);

  async function openAddons() {
    setAddonsOpen(true);
    await refreshAddonSuggestions();
  }

  // Deliberately explicit rather than automatic: this reads every plugin's assembly, which is
  // far more expensive than the folder listing a scan does.
  async function handleDetectAddonLinks() {
    setAddonBusy(true);
    try {
      const result = await window.modManagerAPI.detectAddonLinks();
      if (result.success) {
        setAddonLinks(result.links ?? []);
        setAddonIntegrations(result.integrations ?? []);
        setAddonsScanned(true);
        pushToast(
          `Found ${result.links?.length ?? 0} relationship(s) and ${result.integrations?.length ?? 0} optional integration(s).`,
          true
        );
      } else {
        pushToast(result.message ?? "Couldn't read the installed mods.", false);
      }
    } finally {
      setAddonBusy(false);
    }
  }

  async function handleInstallForgeAddon(addonId: number) {
    setAddonBusy(true);
    try {
      const result = await window.modManagerAPI.installForgeAddon(`addon-${addonId}`, addonId);
      pushToast(tMsg(result.message), result.success);
      if (result.success) {
        await refreshMods();
        await refreshAddonSuggestions();
      }
    } finally {
      setAddonBusy(false);
    }
  }

  async function handleInstallAddonFromFile(parentName: string) {
    setAddonBusy(true);
    try {
      const result = await window.modManagerAPI.installAddonFromFile(parentName);
      if (result.cancelled) return;
      pushToast(tMsg(result.message ?? (result.success ? "Installed." : "Couldn't install.")), result.success);
      if (result.success) {
        await refreshMods();
        await refreshAddonSuggestions();
      }
    } finally {
      setAddonBusy(false);
    }
  }

  async function handleSetAddonParent(id: string, type: ModType, parent: string | null) {
    const result = await window.modManagerAPI.setAddonParent(id, type, parent);
    pushToast(result.message, result.success);
    if (result.success) {
      await refreshMods();
      if (addonsScanned) await handleDetectAddonLinks();
    }
  }

  /* --- the shared preset store (phase 2) ------------------------------------
   * A folder other people can also reach. Everything here is one round trip that returns a
   * fresh status, so the panel never has to guess whether the store changed underneath it —
   * it is a shared folder, so it genuinely might have.
   */
  const [storeStatus, setStoreStatus] = useState<PresetStoreStatus | null>(null);
  const [presetIdentity, setPresetIdentity] = useState<string>("");

  const refreshStore = useCallback(async () => {
    const [status, identity] = await Promise.all([
      window.modManagerAPI.getPresetStoreStatus(),
      window.modManagerAPI.getPresetIdentity()
    ]);
    setStoreStatus(status);
    setPresetIdentity(identity.identity);
    if (status.connected) {
      const usage = await window.modManagerAPI.getStoreUsage();
      setStoreUsage(usage.success ? usage.usage ?? null : null);
    }
  }, []);

  async function withStoreBusy<T>(fn: () => Promise<T>): Promise<T> {
    setPresetBusy(true);
    try {
      return await fn();
    } finally {
      setPresetBusy(false);
    }
  }

  async function handleChooseStore() {
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.choosePresetStore();
      if (result.cancelled) return;
      if (result.status) setStoreStatus(result.status);
      // Connecting to a folder that is not a store yet is not an error; the panel then
      // offers to create one there.
      if (result.status && !result.status.connected && result.status.message) {
        pushToast(result.status.message, false);
      }
    });
  }

  async function handleCreateStore(name: string, writePolicy: WritePolicy) {
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.createPresetStore(name, writePolicy);
      pushToast(result.message, result.success);
      if (result.status) setStoreStatus(result.status);
    });
  }

  async function handleDisconnectStore() {
    const result = await window.modManagerAPI.disconnectPresetStore();
    pushToast(result.message, result.success);
    await refreshStore();
  }

  async function handleSetIdentity(name: string) {
    const result = await window.modManagerAPI.setPresetIdentity(name);
    pushToast(result.message, result.success);
    if (result.success) await refreshStore();
  }

  async function handleSetStorePolicy(policy: WritePolicy) {
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.setPresetStorePolicy(policy);
      pushToast(result.message, result.success);
      if (result.status) setStoreStatus(result.status);
    });
  }

  async function handlePublishPreset(id: string) {
    await withStoreBusy(async () => {
      let result = await window.modManagerAPI.publishPreset(id);
      // Publishing over someone ELSE's preset is the only thing that asks. Ids come from the
      // preset's name, so two people can collide entirely by accident.
      if (result.needsConfirmation) {
        if (!window.confirm(`${result.message}\n\nPublish anyway?`)) return;
        result = await window.modManagerAPI.publishPreset(id, true);
      }
      pushToast(result.message, result.success);
      if (result.status) setStoreStatus(result.status);
    });
  }

  async function handleUnpublishPreset(id: string) {
    const entry = storeStatus?.entries.find((e) => e.preset.id === id);
    if (!window.confirm(`Remove "${entry?.preset.name ?? id}" from the shared store?\n\nYour local copy is kept.`)) return;
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.unpublishPreset(id);
      pushToast(result.message, result.success);
      if (result.status) setStoreStatus(result.status);
    });
  }

  async function handleImportFromStore(id: string) {
    await withStoreBusy(async () => {
      let result = await window.modManagerAPI.importPreset(id);
      if (result.needsConfirmation) {
        if (!window.confirm(`${result.message}\n\nImport anyway?`)) return;
        result = await window.modManagerAPI.importPreset(id, true);
      }
      pushToast(result.message ?? "Imported.", result.success);
      if (result.success && result.preset) {
        await refreshPresets();
        await handleSelectPreset(result.preset.id);
      }
    });
  }

  /* --- payloads (phase 3) ---------------------------------------------------
   * The only preset operations that can run for tens of minutes, so they stream progress and
   * can be stopped. Stopping is safe: copies are staged and renamed into place only when
   * complete, and staging resumes rather than restarting.
   */
  const [payloadProgress, setPayloadProgress] = useState<PayloadProgress | null>(null);
  const [storeUsage, setStoreUsage] = useState<StoreUsage | null>(null);

  useEffect(() => window.modManagerAPI.onPresetPayloadProgress(setPayloadProgress), []);

  const refreshStoreUsage = useCallback(async () => {
    const result = await window.modManagerAPI.getStoreUsage();
    setStoreUsage(result.success ? result.usage ?? null : null);
  }, []);

  async function handlePublishWithPayloads(id: string) {
    const preset = presets.find((p) => p.id === id);
    if (
      !window.confirm(
        `Publish "${preset?.name ?? id}" WITH its mod files?\n\n` +
          `This copies every mod in the preset into the shared store. The first publish can be large — the reference install is 17.8 GB — but mods are stored once and shared between presets, so later publishes only copy what is new.\n\n` +
          `You can stop it at any point; progress is kept.`
      )
    )
      return;

    setPayloadProgress(null);
    await withStoreBusy(async () => {
      let result = await window.modManagerAPI.publishPresetWithPayloads(id);
      if (result.needsConfirmation) {
        if (!window.confirm(`${result.message}\n\nPublish anyway?`)) return;
        result = await window.modManagerAPI.publishPresetWithPayloads(id, true);
      }
      pushToast(result.message, result.success);
      // Which mods could not be gathered matters more than the headline: the preset is still
      // published, just carrying less than it says.
      if (result.failed?.length) {
        pushToast(`Not carried: ${result.failed.map((f) => f.name).join(", ")}`, false);
      }
      if (result.status) setStoreStatus(result.status);
      await Promise.all([refreshPresets(), refreshStoreUsage()]);
    });
    setPayloadProgress(null);
  }

  async function handleInstallPayloads(id: string) {
    const entry = storeStatus?.entries.find((e) => e.preset.id === id);
    const carried = entry?.preset.mods.filter((m) => m.payload).length ?? 0;
    if (
      !window.confirm(
        `Install the ${carried} mod(s) this preset carries?\n\n` +
          `Files are copied straight from the store — no Forge, no downloads. Mods you already have are overwritten with the preset's copies; mods not in the preset are left alone.`
      )
    )
      return;

    setPayloadProgress(null);
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.installPresetPayloads(id);
      pushToast(result.message, result.success);
      // "Named but not carried" is a different problem from "failed", and sends the user
      // somewhere else entirely — to the mod's own page rather than to a retry.
      if (result.skipped?.length) {
        pushToast(`${result.skipped.length} mod(s) are named but not carried by this preset.`, false);
      }
      await refreshMods();
      if (selectedPresetId) await loadPresetReport(selectedPresetId);
    });
    setPayloadProgress(null);
  }

  async function handleVerifyPayloads(id: string, deep: boolean) {
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.verifyPresetPayloads(id, deep);
      pushToast(result.message, result.success);
    });
  }

  async function handleCleanStore() {
    if (!window.confirm("Delete payloads no preset in this store refers to any more?\n\nPresets are not touched.")) return;
    await withStoreBusy(async () => {
      const result = await window.modManagerAPI.cleanStorePayloads();
      pushToast(result.message, result.success);
      await refreshStoreUsage();
    });
  }

  async function handleCancelPayloads() {
    const result = await window.modManagerAPI.cancelPresetPayloads();
    pushToast(result.message, true);
  }

  async function handleExportPresetFile(id: string) {
    const result = await window.modManagerAPI.exportPresetFile(id);
    if (result.cancelled) return;
    pushToast(result.message ?? (result.success ? "Exported." : "Couldn't export."), result.success);
  }

  async function handleImportPresetFile() {
    await withStoreBusy(async () => {
      let result = await window.modManagerAPI.importPresetFile();
      if (result.cancelled) return;
      if (result.needsConfirmation) {
        if (!window.confirm(`${result.message}\n\nImport anyway?`)) return;
        // Reuses the file already chosen rather than making them find it a second time.
        result = await window.modManagerAPI.importPresetFile(true, result.path);
      }
      pushToast(result.message ?? (result.success ? "Imported." : "Couldn't import."), result.success);
      if (result.success && result.preset) {
        await refreshPresets();
        await handleSelectPreset(result.preset.id);
      }
    });
  }

  /**
   * Installs a mod the server runs but this install lacks (or has an older copy of).
   *
   * Always installs into the MAIN instance, never the headless client: the headless client
   * gets its copy by syncing from main, which is the only way to guarantee the two ends
   * agree on a version. The Forge lookup leads with the GUID the server reported, since that
   * is an exact identifier — falling back to the name is what produced wrong matches in V1.
   */
  async function handleInstallFromServer(row: ServerSyncRow) {
    const lookupName = row.serverName ?? row.name;
    setInstallingFromServer(row.key);
    try {
      const found = await window.modManagerAPI.findForgeDownloadsForNames([{ name: lookupName, guid: row.guid }]);
      const hit = found[lookupName];
      if (!hit) {
        pushToast(
          `Couldn't find "${lookupName}" on Forge.` +
            (row.url ? " It does list a source repository — open it from the row." : ""),
          false
        );
        return;
      }
      const queueId = pushQueueItem(hit.forgeName ?? lookupName);
      markQueueActive(queueId);
      const result = await installArchiveWithConfirmFlow(
        window.modManagerAPI.installForgeMod(queueId, hit.downloadLink, hit.forgeName ?? lookupName, {
          name: hit.forgeName,
          version: hit.version,
          guid: hit.guid
        })
      );
      markQueueDone(queueId, result.success, tMsg(result.message));
      pushToast(tMsg(result.message), result.success);
      if (result.success) {
        await refreshMods();
        await refreshMulti();
      }
    } finally {
      setInstallingFromServer(null);
    }
  }

  async function handleSyncMod(mod: ModInfo) {
    setSyncing(true);
    try {
      const result = await window.modManagerAPI.syncModToHeadless(mod);
      pushToast(tMsg(result.message), result.success);
      await refreshHeadless();
    } finally {
      setSyncing(false);
    }
  }

  async function handleRemoveFromHeadless(mod: ModInfo) {
    if (!window.confirm(`Remove "${mod.name}" from the headless client? The main install is untouched.`)) return;
    const result = await window.modManagerAPI.removeModFromHeadless(mod);
    pushToast(tMsg(result.message), result.success);
    await refreshHeadless();
  }

  // Bulk sync is confirmed first because it overwrites whatever is on the headless side —
  // that overwrite IS the drift repair, but it should not be a surprise.
  async function handleSyncAll() {
    const pending = headlessData?.parity?.counts;
    const total = (pending?.missingOnHeadless ?? 0) + (pending?.versionDrift ?? 0);
    if (total === 0) {
      pushToast("Nothing to sync — the headless client already matches.", true);
      return;
    }
    if (
      !window.confirm(
        `Copy ${total} plugin(s) from the main install to the headless client?\n\n` +
          "Anything already there with the same name is replaced. Only mods that must match are copied — " +
          "display-only and stash-only plugins are left alone."
      )
    ) {
      return;
    }
    setSyncing(true);
    try {
      const result = await window.modManagerAPI.syncAllToHeadless();
      pushToast(tMsg(result.message), result.success);
      await refreshHeadless();
    } finally {
      setSyncing(false);
    }
  }

  async function handleInstanceOpenFolder(mod: ModInfo, target: InstanceId) {
    const result = await window.modManagerAPI.openModFolder(mod, target);
    if (!result.success) pushToast(tMsg(result.message), false);
  }

  // Closes the open actions menu when clicking outside it.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".action-menu-wrapper")) setOpenMenuKey(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const summary = useMemo(() => {
    const server = mods.filter((m) => m.type === "server").length;
    const client = mods.filter((m) => m.type === "client").length;
    const active = mods.filter((m) => m.enabled).length;
    const disabled = mods.length - active;
    return { total: mods.length, server, client, active, disabled };
  }, [mods]);

  // Extracted from the single-instance list so the multi-instance panes filter and sort by
  // exactly the same rules. Searching for "SAIN" has to mean the same thing in every pane;
  // two implementations would drift and the divergence would look like a scanning bug.
  const applyFilterSort = useCallback((source: ModInfo[]) => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = source.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      if (statusFilter === "enabled" && !m.enabled) return false;
      if (statusFilter === "disabled" && m.enabled) return false;
      if (originFilter === "manual" && !m.installedManually) return false;
      if (originFilter === "manager" && m.installedManually) return false;
      return true;
    });

    // Natural comparison: "Mod 10" after "Mod 2" (not before, as plain text comparison
    // would give), and case-insensitive — otherwise "Zebra" sorted ahead of "apple".
    const byName = (a: ModInfo, b: ModInfo) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

    // Whatever needs action first: update available > blocked > incompatible >
    // informational only > no known status.
    const forgeRank = (mod: ModInfo) => {
      const status = forgeStatusByName.get(mod.name)?.status;
      return status === "update" ? 0 : status === "blocked" ? 1 : status === "incompatible" ? 2 : status === "info" ? 3 : 4;
    };

    const sorted = [...filtered].sort((a, b) => {
      // Mods with no install date (those installed outside the app) have nowhere to sit in
      // a chronological order — they always go to the end, in both directions, rather than
      // pretending to be the "oldest".
      if (sortField === "installedAt") {
        const da = a.installedAt ?? "";
        const db = b.installedAt ?? "";
        if (!da !== !db) return da ? -1 : 1;
        if (!da && !db) return byName(a, b);
      }

      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = byName(a, b);
          break;
        case "status":
          cmp = Number(b.enabled) - Number(a.enabled) || byName(a, b);
          break;
        case "origin":
          cmp = Number(a.installedManually) - Number(b.installedManually) || byName(a, b);
          break;
        case "installedAt":
          cmp = (a.installedAt ?? "").localeCompare(b.installedAt ?? "") || byName(a, b);
          break;
        case "forge":
          cmp = forgeRank(a) - forgeRank(b) || byName(a, b);
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [searchQuery, typeFilter, statusFilter, originFilter, sortField, sortDirection, forgeStatusByName]);

  const filteredMods = useMemo(() => applyFilterSort(mods), [applyFilterSort, mods]);

  const filtersActive = searchQuery.trim() !== "" || typeFilter !== "all" || statusFilter !== "all" || originFilter !== "all";

  function clearFilters() {
    setSearchQuery("");
    setTypeFilter("all");
    setStatusFilter("all");
    setOriginFilter("all");
  }

  useEffect(() => {
    (async () => {
      const instance = await window.modManagerAPI.getSptPath();
      setSptPath(instance?.path ?? null);
      setServerRoot(instance?.serverRoot ?? null);
      setIsSplitInstance(instance?.split ?? false);
      if (instance?.path) {
        refreshMods();
        setSptVersion(await window.modManagerAPI.getSptVersion());
        const semver = await window.modManagerAPI.getSptSemver();
        if (semver) {
          setSptVersionInput(semver);
        } else {
          const override = await window.modManagerAPI.getSptVersionOverride();
          if (override) setSptVersionInput(override);
        }

        window.modManagerAPI.getForgeSptVersions().then(setForgeSptVersions);

        const cache = await window.modManagerAPI.getForgeCache();
        if (cache.statusCache) {
          const restored = new Map(cache.statusCache.map((entry) => [entry.name, { status: entry.status, version: entry.version }]));
          setForgeStatusByName(restored);
        }
        setForgeCheckedAt(cache.checkedAt);
      }
    })();
  }, [refreshMods]);

  async function handleSelectFolder() {
    const result = await window.modManagerAPI.selectSptFolder();
    if (result.success && result.path) {
      setSptPath(result.path);
      setServerRoot(result.serverRoot ?? result.path);
      setIsSplitInstance(result.split ?? false);
      pushToast(tMsg(result.message) || t("toast.instanceConfigured"), true);
      refreshMods();
      setSptVersion(await window.modManagerAPI.getSptVersion());
      const semver = await window.modManagerAPI.getSptSemver();
      if (semver) {
        setSptVersionInput(semver);
      } else {
        const override = await window.modManagerAPI.getSptVersionOverride();
        setSptVersionInput(override || "");
      }
      // Without this, the SPT version dropdown showed only the placeholder the first time
      // someone selected the folder — it only populated after closing and reopening the
      // app (when the startup effect, which already fetched this, finally ran with a saved
      // sptPath).
      window.modManagerAPI.getForgeSptVersions().then(setForgeSptVersions);
    } else {
      pushToast(tMsg(result.message) || t("toast.folderSelectFailed"), false);
    }
  }

  function handleOpenModHub() {
    window.modManagerAPI.openModHub();
  }

  const confirmResolverRef = useRef<((result: InstallResult) => void) | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ tmpDir: string; archivePath: string; rootEntries: string[] } | null>(null);

  // The single point every installation passes through. If the backend replies asking for
  // confirmation (unusual file structure), this opens the modal and "pauses" here until
  // the user decides — the caller only ever sees the final result (installed or cancelled).
  async function installArchiveWithConfirmFlow(installCall: Promise<InstallResult>): Promise<InstallResult> {
    const result = await installCall;
    if (!result.needsConfirmation || !result.tmpDir) return result;
    return new Promise<InstallResult>((resolve) => {
      confirmResolverRef.current = resolve;
      setPendingConfirm({ tmpDir: result.tmpDir!, archivePath: result.archivePath ?? "", rootEntries: result.rootEntries ?? [] });
    });
  }

  async function handleConfirmProceed() {
    if (!pendingConfirm) return;
    const { tmpDir, archivePath } = pendingConfirm;
    setPendingConfirm(null);
    const result = await window.modManagerAPI.confirmUnrecognizedInstall(tmpDir, archivePath);
    confirmResolverRef.current?.(result);
    confirmResolverRef.current = null;
  }

  async function handleConfirmAbort() {
    if (!pendingConfirm) return;
    const { tmpDir } = pendingConfirm;
    setPendingConfirm(null);
    const result = await window.modManagerAPI.abortUnrecognizedInstall(tmpDir);
    confirmResolverRef.current?.({ success: false, message: result.message });
    confirmResolverRef.current = null;
  }

  async function handleInstall() {
    setLoading(true);
    const previousKeys = new Set(mods.map(selectionKey));
    const result = await installArchiveWithConfirmFlow(window.modManagerAPI.installMod());
    pushToast(tMsg(result.message), result.success);
    setLoading(false);
    if (result.success) {
      const updated = await refreshMods();
      checkForgeForNewMods(previousKeys, updated);
    }
  }

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      setDragCounter((c) => c + 1);
      setIsDraggingFile(true);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setDragCounter((c) => {
      const next = c - 1;
      if (next <= 0) setIsDraggingFile(false);
      return Math.max(next, 0);
    });
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDraggingFile(false);
    setDragCounter(0);

    const files = Array.from(e.dataTransfer.files);
    const archives = files.filter((f) => /\.(zip|7z|rar)$/i.test(f.name));

    if (archives.length === 0) {
      pushToast(t("toast.dropInvalidFile"), false);
      return;
    }

    setLoading(true);
    const previousKeys = new Set(mods.map(selectionKey));
    let successCount = 0;
    // Pre-populates the queue with every file at once, so what is coming next is visible
    // immediately — without this, a batch of several files processed silently, one at a time.
    const queueIds = archives.map((file) => pushQueueItem(file.name));
    for (let i = 0; i < archives.length; i++) {
      const file = archives[i];
      const queueId = queueIds[i];
      // @ts-expect-error Electron injects `.path` onto the native File object, outside the standard DOM typings
      const filePath: string | undefined = file.path;
      if (!filePath) {
        markQueueDone(queueId, false, t("queue.noFilePath"));
        continue;
      }
      markQueueActive(queueId);
      const result = await installArchiveWithConfirmFlow(window.modManagerAPI.installModFromPath(filePath));
      if (result.success) successCount++;
      markQueueDone(queueId, result.success, tMsg(result.message));
      pushToast(tMsg(result.message), result.success);
    }
    setLoading(false);
    if (successCount > 0) {
      const updated = await refreshMods();
      checkForgeForNewMods(previousKeys, updated);
    }
  }

  async function handleToggle(mod: ModInfo) {
    setMutating(true);
    const result = await window.modManagerAPI.toggleMod(mod);
    pushToast(tMsg(result.message), result.success);
    if (result.success) {
      // Local update (no full disk re-scan) — much faster with many mods.
      //
      // Includes the OTHER PARTS of the same package: the backend toggles them together,
      // and without this the list kept showing the other half in its old state — which
      // looked like the cascade had not worked.
      setMods((prev) =>
        prev.map((m) => {
          const isSame = m.id === mod.id && m.type === mod.type;
          const isSamePackage = !!mod.packageId && m.packageId === mod.packageId;
          return isSame || isSamePackage ? { ...m, enabled: !mod.enabled } : m;
        })
      );
    }
    setMutating(false);
  }

  async function handleUninstall(mod: ModInfo) {
    const confirmed = window.confirm(t("toast.confirmRemove", { name: mod.name }));
    if (!confirmed) return;
    setMutating(true);
    const result = await window.modManagerAPI.uninstallMod(mod);
    pushToast(tMsg(result.message), result.success);
    if (result.success) {
      const key = selectionKey(mod);
      setMods((prev) => prev.filter((m) => selectionKey(m) !== key));
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    setMutating(false);
  }

  async function handleOpenFolder(mod: ModInfo) {
    const result = await window.modManagerAPI.openModFolder(mod);
    if (!result.success) pushToast(tMsg(result.message), false);
  }

  async function handleReinstall() {
    pushToast(t("toast.selectUpdatedFile"), true);
    await handleInstall();
  }

  async function handleExportList() {
    const result = await window.modManagerAPI.exportModList();
    pushToast(tMsg(result.message), result.success);
  }

  async function handleImportList() {
    const result = await window.modManagerAPI.importModList();
    pushToast(tMsg(result.message), result.success);
    if (!result.success || !result.comparison) return;
    setCompareResult(result.comparison);

    const { missing, extra } = result.comparison;

    if (missing.length > 0) {
      const wantsDownload = window.confirm(t("restore.confirmDownload", { count: missing.length }));
      if (wantsDownload) {
        const previousKeys = new Set(mods.map(selectionKey));

        // The exported list stores folder names, and names can repeat between a server mod
        // and a client mod (e.g. "Wedge" on both sides). Without removing duplicates, the
        // same mod was downloaded twice.
        const targets = [...new Set(missing)];

        // Phase 1: one batched lookup for everything, with a single summary card. Filling
        // the queue with an item per mod seemed informative, but with 118 mods it pushed
        // the progress line itself out of the panel's visible area.
        setLookupInProgress(true);
        const guidByName = result.guidByName ?? {};
        const found = await window.modManagerAPI.findForgeDownloadsForNames(
          targets.map((name) => ({ name, guid: guidByName[name] }))
        );
        setLookupInProgress(false);
        setForgeProgress(null);

        // Phase 2: install only what was found, one at a time, with a visible count.
        const installable = targets.filter((name) => found[name]);
        const notFound = targets.filter((name) => !found[name]);
        let installedCount = 0;
        const failed: string[] = [];

        for (let i = 0; i < installable.length; i++) {
          const name = installable[i];
          const lookup = found[name]!;
          setInstallProgress({ done: i + 1, total: installable.length });
          const queueId = pushQueueItem(lookup.forgeName ?? name);
          markQueueActive(queueId);
          const installResult = await installArchiveWithConfirmFlow(
            window.modManagerAPI.installForgeMod(queueId, lookup.downloadLink, lookup.forgeName ?? name, {
              name: lookup.forgeName,
              version: lookup.version,
              // Records the Forge identifier: from here on this mod is recognised by exact
              // ID, with no dependence on name matching.
              guid: lookup.guid
            })
          );
          markQueueDone(queueId, installResult.success, tMsg(installResult.message));
          if (installResult.success) installedCount++;
          else failed.push(name);
        }
        setInstallProgress(null);

        const problems = [...notFound, ...failed];
        pushToast(
          problems.length === 0
            ? t("restore.allInstalled", { count: installedCount })
            : t("restore.partialInstalled", {
                installed: installedCount,
                // On a large list, dumping 100+ names into a toast helps nobody.
                notFound:
                  problems.slice(0, 5).join(", ") +
                  (problems.length > 5 ? t("restore.andMore", { count: problems.length - 5 }) : "")
              }),
          problems.length === 0
        );
        if (installedCount > 0) {
          const updated = await refreshMods();
          checkForgeForNewMods(previousKeys, updated);
        }
      }
    }

    if (extra.length > 0) {
      const wantsDisable = window.confirm(t("restore.confirmDisable", { count: extra.length }));
      if (wantsDisable) {
        const targets = mods.filter((m) => extra.includes(m.originalName) && m.enabled);
        let disabledCount = 0;
        for (const mod of targets) {
          const toggleResult = await window.modManagerAPI.toggleMod(mod);
          if (toggleResult.success) disabledCount++;
        }
        pushToast(t("restore.disabledCount", { count: disabledCount }), true);
        if (disabledCount > 0) refreshMods();
      }
    }
  }

  async function handleDetectConflicts() {
    setCheckingConflicts(true);
    const report = await window.modManagerAPI.detectConflicts();
    setConflictReport(report);
    setCheckingConflicts(false);
    const total = report.clientFileConflicts.length + report.duplicateServerNames.length;
    pushToast(total === 0 ? t("toast.noConflictsFound") : t("toast.conflictsFound", { count: total }), total === 0);
  }

  function persistForgeStatus(map: Map<string, { status: "update" | "blocked" | "incompatible" | "info"; version?: string }>) {
    const asArray: ForgeStatusCacheEntry[] = Array.from(map.entries()).map(([name, v]) => ({ name, ...v }));
    window.modManagerAPI.setForgeCache(asArray);
    setForgeCheckedAt(new Date().toISOString());
  }

  async function handleCheckForgeUpdates() {
    if (!sptVersionInput.trim()) {
      pushToast(t("toast.enterSptVersion"), false);
      return;
    }
    setCheckingForgeUpdates(true);
    setForgeError(null);
    const payload = mods.map((m) => ({
      name: m.name,
      originalName: m.originalName,
      version: m.version,
      guid: m.guid,
      // Carried through so the backend can inherit a match across parts of one package.
      // Dropping these leaves every mod in a group of one and quietly disables that.
      packageId: m.packageId,
      packageInferred: m.packageInferred
    }));
    const response = await window.modManagerAPI.checkForgeUpdates(payload, sptVersionInput.trim());
    setCheckingForgeUpdates(false);
    setForgeProgress(null);
    if (!response.success || !response.result) {
      const message = tMsg(response.message) || t("toast.forgeUpdateCheckFailed");
      setForgeError(message);
      pushToast(message, false);
      return;
    }
    setForgeResult(response.result);

    const statusMap = new Map<string, { status: "update" | "blocked" | "incompatible" | "info"; version?: string }>();
    for (const u of response.result.updates) {
      statusMap.set(u.name, { status: "update", version: u.recommendedVersion });
    }
    for (const b of response.result.blocked) {
      if (!statusMap.has(b.name)) statusMap.set(b.name, { status: "blocked", version: b.recommendedVersion });
    }
    for (const i of response.result.incompatible) {
      if (!statusMap.has(i.name)) statusMap.set(i.name, { status: "incompatible" });
    }
    for (const info of response.result.infoOnly) {
      if (!statusMap.has(info.name)) statusMap.set(info.name, { status: "info", version: info.recommendedVersion });
    }
    setForgeStatusByName(statusMap);
    persistForgeStatus(statusMap);

    const total = response.result.updates.length;
    pushToast(total === 0 ? t("toast.forgeAllUpToDate") : t("toast.forgeUpdatesAvailable", { count: total }), true);
  }

  // Runs the Forge check only for mods that just arrived (by diffing the list before and
  // after installation), without re-querying the ones already verified. Silently does
  // nothing if no SPT version has been supplied yet (there is no way to check without it).
  async function checkForgeForNewMods(previousKeys: Set<string>, updatedMods: ModInfo[]) {
    if (!sptVersionInput.trim()) return;
    const newMods = updatedMods.filter((m) => !previousKeys.has(selectionKey(m)));
    if (newMods.length === 0) return;

    const payload = newMods.map((m) => ({
      name: m.name,
      originalName: m.originalName,
      version: m.version,
      guid: m.guid,
      // Carried through so the backend can inherit a match across parts of one package.
      // Dropping these leaves every mod in a group of one and quietly disables that.
      packageId: m.packageId,
      packageInferred: m.packageInferred
    }));
    const response = await window.modManagerAPI.checkForgeUpdates(payload, sptVersionInput.trim());
    if (!response.success || !response.result) return;

    const next = new Map(forgeStatusByName);
    for (const u of response.result.updates) next.set(u.name, { status: "update", version: u.recommendedVersion });
    for (const b of response.result.blocked) {
      if (!next.has(b.name)) next.set(b.name, { status: "blocked", version: b.recommendedVersion });
    }
    for (const i of response.result.incompatible) {
      if (!next.has(i.name)) next.set(i.name, { status: "incompatible" });
    }
    for (const info of response.result.infoOnly) {
      if (!next.has(info.name)) next.set(info.name, { status: "info", version: info.recommendedVersion });
    }
    setForgeStatusByName(next);
    persistForgeStatus(next);
  }

  async function runForgeSearch(page: number) {
    setBrowseLoading(true);
    setBrowseError(null);
    const response = await window.modManagerAPI.searchForgeMods({
      query: browseQuery.trim() || undefined,
      categorySlug: browseCategory || undefined,
      sptVersionConstraint: browseOnlyCompatible && sptVersionInput.trim() ? sptVersionInput.trim() : undefined,
      page
    });
    setBrowseLoading(false);
    if (!response.success || !response.result) {
      setBrowseError(tMsg(response.message) || t("toast.forgeSearchFailed"));
      return;
    }
    setBrowseResults(response.result.mods);
    setBrowsePage(response.result.page);
    setBrowseLastPage(response.result.lastPage);
  }

  async function handleOpenBrowse() {
    setBrowseOpen(true);
    if (browseCategories.length === 0) {
      window.modManagerAPI.getForgeCategories().then(setBrowseCategories);
    }
    runForgeSearch(1);
  }

  function handleSelectVersion(modId: number, versionId: number) {
    setSelectedVersionByModId((prev) => new Map(prev).set(modId, versionId));
  }

  const [updatingModName, setUpdatingModName] = useState<string | null>(null);

  /**
   * "I already have this." Some authors ship a new build without bumping the version
   * recorded inside the files, so Forge reports a version the installed copy already is.
   * Nothing local can tell the difference — only the user knows — so this records their
   * answer and stops offering that specific version.
   */
  async function dismissUpdate(originalName: string, version: string, displayName: string) {
    const res = await window.modManagerAPI.dismissForgeUpdate(originalName, version);
    pushToast(tMsg(res.message) || t("forge.dismissed", { name: displayName, version }), res.success);
    if (res.success) {
      setForgeResult((prev) =>
        prev ? { ...prev, updates: prev.updates.filter((u) => u.originalName !== originalName) } : prev
      );
      // The row also carries an "update available" marker in the mod list; clear it so the
      // list agrees with the panel.
      setForgeStatusByName((prev) => {
        const next = new Map(prev);
        next.delete(displayName);
        return next;
      });
    }
  }

  /**
   * Accepts a guessed match. The pin outranks all automatic strategies from here on, so
   * the same guess never has to be re-made or re-confirmed.
   */
  async function confirmForgeMatch(originalName: string, modId: number, label: string) {
    const res = await window.modManagerAPI.setForgeMatch(originalName, modId);
    pushToast(tMsg(res.message) || t("forge.linkSaved", { name: label }), res.success);
    if (res.success) {
      setForgeResult((prev) =>
        prev ? { ...prev, unconfirmed: (prev.unconfirmed ?? []).filter((u) => u.originalName !== originalName) } : prev
      );
    }
  }

  /**
   * Opens the relink dialog. This is a real modal rather than window.prompt() because
   * Electron does not implement prompt() at all — calling it throws
   * "prompt() is and will not be supported." and the button silently does nothing.
   * (window.confirm IS supported, which is why the removal dialogs elsewhere work.)
   */
  function relinkForgeMatch(originalName: string, displayName: string) {
    setRelinkTarget({ originalName, displayName });
    setRelinkInput("");
  }

  /**
   * Accepts either a bare numeric id or a Forge URL pasted straight from the browser,
   * because a URL is what someone actually has to hand after looking a mod up.
   */
  async function submitRelink() {
    if (!relinkTarget) return;
    const trimmed = relinkInput.trim();
    if (!trimmed) return;
    // "https://forge.sp-tarkov.com/mod/791/sain" -> 791, and a bare "791" -> 791
    const fromUrl = /forge\.sp-tarkov\.com\/mod\/(\d+)/i.exec(trimmed);
    const modId = Number(fromUrl ? fromUrl[1] : trimmed);
    if (!Number.isFinite(modId) || modId <= 0) {
      pushToast(t("forge.relinkInvalid"), false);
      return;
    }
    const target = relinkTarget;
    setRelinkTarget(null);
    await confirmForgeMatch(target.originalName, modId, String(modId));
  }

  // Updates without leaving the app: the result's link is a direct download of the
  // recommended version, so it can go through the same installer used by Forge search —
  // instead of opening a browser and leaving a .zip in Downloads to install by hand.
  async function handleInstallUpdate(modName: string, downloadLink: string, version?: string, guid?: string) {
    setUpdatingModName(modName);
    const previousKeys = new Set(mods.map(selectionKey));
    const queueId = pushQueueItem(modName);
    markQueueActive(queueId);
    const result = await installArchiveWithConfirmFlow(
      window.modManagerAPI.installForgeMod(queueId, downloadLink, modName, { name: modName, version, guid })
    );
    markQueueDone(queueId, result.success, tMsg(result.message));
    setUpdatingModName(null);
    pushToast(tMsg(result.message), result.success);
    if (result.success) {
      const updated = await refreshMods();
      checkForgeForNewMods(previousKeys, updated);
    }
  }

  async function handleInstallFromForge(mod: ForgeCatalogMod) {
    const versionId = selectedVersionByModId.get(mod.id) ?? mod.versions[0]?.id;
    const version = mod.versions.find((v) => v.id === versionId) ?? mod.versions[0];
    if (!version) {
      pushToast(t("browse.noVersionPublished", { name: mod.name }), false);
      return;
    }
    setInstallingModId(mod.id);
    const previousKeys = new Set(mods.map(selectionKey));
    const queueId = pushQueueItem(mod.name);
    markQueueActive(queueId);
    const result = await installArchiveWithConfirmFlow(
      window.modManagerAPI.installForgeMod(queueId, version.link, mod.name, {
        name: mod.name,
        author: mod.author,
        version: version.version,
        guid: mod.guid
      })
    );
    markQueueDone(queueId, result.success, tMsg(result.message));
    setInstallingModId(null);
    pushToast(tMsg(result.message), result.success);
    if (result.success) {
      const updated = await refreshMods();
      checkForgeForNewMods(previousKeys, updated);
    }
  }

  function startRename(mod: ModInfo) {
    setEditingKey(selectionKey(mod));
    setEditingValue(mod.name);
    setOpenMenuKey(null);
  }

  function cancelRename() {
    setEditingKey(null);
    setEditingValue("");
  }

  async function confirmRename(mod: ModInfo) {
    const trimmed = editingValue.trim();
    const newAlias = trimmed === mod.originalName ? "" : trimmed;
    const result = await window.modManagerAPI.renameMod(mod.id, newAlias);
    pushToast(tMsg(result.message), result.success);
    setEditingKey(null);
    if (result.success) {
      const displayName = newAlias || mod.originalName;
      setMods((prev) => prev.map((m) => (m.id === mod.id && m.type === mod.type ? { ...m, name: displayName } : m)));
    }
  }

  function toggleSelect(mod: ModInfo) {
    const key = selectionKey(mod);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedKeys(new Set(filteredMods.map(selectionKey)));
  }

  function clearSelection() {
    setSelectedKeys(new Set());
  }

  const selectedMods = useMemo(() => mods.filter((m) => selectedKeys.has(selectionKey(m))), [mods, selectedKeys]);

  async function runBulk(action: "enable" | "disable" | "remove") {
    if (selectedMods.length === 0) return;
    if (action === "remove") {
      const confirmed = window.confirm(t("toast.confirmRemoveBulk", { count: selectedMods.length }));
      if (!confirmed) return;
    }
    setMutating(true);
    const succeededKeys = new Set<string>();
    for (const mod of selectedMods) {
      if (action === "enable" && mod.enabled) continue;
      if (action === "disable" && !mod.enabled) continue;
      const result = action === "remove" ? await window.modManagerAPI.uninstallMod(mod) : await window.modManagerAPI.toggleMod(mod);
      if (result.success) succeededKeys.add(selectionKey(mod));
    }

    if (action === "remove") {
      setMods((prev) => prev.filter((m) => !succeededKeys.has(selectionKey(m))));
    } else {
      setMods((prev) => prev.map((m) => (succeededKeys.has(selectionKey(m)) ? { ...m, enabled: action === "enable" } : m)));
    }

    pushToast(t("toast.bulkProcessed", { done: succeededKeys.size, total: selectedMods.length }), true);
    // In bulk, a package item drags its sibling parts along — the local update above does
    // not know that, so re-scan to make the list agree with the disk.
    if (selectedMods.some((m) => m.packageId)) refreshMods();
    clearSelection();
    setMutating(false);
  }

  function selectRange(keys: string[]) {
    setSelectedKeys((prev) => new Set([...prev, ...keys]));
  }

  // How many parts of each package are installed. Used to flag on the mod's row that it
  // belongs to a set — without it, seeing the other half disable itself looks like a bug.
  const packagePartsById = useMemo(() => {
    const counts = new Map<string, ModInfo[]>();
    for (const m of mods) {
      if (!m.packageId) continue;
      if (!counts.has(m.packageId)) counts.set(m.packageId, []);
      counts.get(m.packageId)!.push(m);
    }
    return counts;
  }, [mods]);

  const listProps = {
    onToggle: handleToggle,
    onUninstall: handleUninstall,
    onOpenFolder: handleOpenFolder,
    onReinstall: handleReinstall,
    onRenameStart: startRename,
    onRenameCancel: cancelRename,
    onRenameConfirm: confirmRename,
    editingKey,
    editingValue,
    onEditingValueChange: setEditingValue,
    selectedKeys,
    onToggleSelect: toggleSelect,
    onRangeSelect: selectRange,
    openMenuKey,
    onSetOpenMenuKey: setOpenMenuKey,
    disabled: mutating,
    forgeStatusByName,
    packagePartsById,
    t
  };

  return (
    <>
      <ToastStack toasts={toasts} />

      {appUpdate?.updateAvailable && !updateDismissed && (
        <div className="update-banner">
          <span>
            {t("update.available", {
              latest: appUpdate.latestVersion ?? "",
              current: appUpdate.currentVersion
            })}
          </span>
          <div className="update-banner-actions">
            {appUpdate.downloadPageUrl && (
              <button
                className="primary"
                onClick={() => window.modManagerAPI.openReleasePage(appUpdate.downloadPageUrl!)}
              >
                {t("update.download")}
              </button>
            )}
            {appUpdate.releaseUrl && (
              <button onClick={() => window.modManagerAPI.openReleasePage(appUpdate.releaseUrl!)}>
                {t("update.viewChangelog")}
              </button>
            )}
            <button onClick={() => setUpdateDismissed(true)}>{t("update.dismiss")}</button>
          </div>
        </div>
      )}

      {downloadQueue.length > 0 && (
        <div className="download-queue-panel">
          {lookupInProgress && (
            <div className="download-queue-item queue-summary-card">
              <div className="queue-item-name">
                {forgeProgress && forgeProgress.total > 0
                  ? t("restore.lookingUpCount", { done: forgeProgress.done, total: forgeProgress.total })
                  : t("restore.lookingUp")}
              </div>
              {forgeProgress && forgeProgress.total > 0 && (
                <>
                  <div className="queue-progress-track">
                    <div
                      className="queue-progress-fill"
                      style={{ width: `${Math.round((forgeProgress.done / forgeProgress.total) * 100)}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          {installProgress && (
            <div className="download-queue-item queue-summary-card">
              <div className="queue-item-name">
                {t("restore.installingProgress", { done: installProgress.done, total: installProgress.total })}
              </div>
              <div className="queue-progress-track">
                <div
                  className="queue-progress-fill"
                  style={{ width: `${Math.round((installProgress.done / installProgress.total) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {downloadQueue.map((item) => {
            const hasProgress = (item.totalBytes ?? 0) > 0;
            const pct = hasProgress ? Math.min(100, Math.round(((item.receivedBytes ?? 0) / item.totalBytes!) * 100)) : null;
            const elapsedSec = item.startedAt ? (Date.now() - item.startedAt) / 1000 : 0;
            const speedBps = item.status === "active" && elapsedSec > 0.5 ? (item.receivedBytes ?? 0) / elapsedSec : 0;
            return (
              <div key={item.id} className={`download-queue-item queue-status-${item.status}`}>
                <div className="queue-item-name" title={item.name}>{item.name}</div>
                {item.status === "queued" && <div className="queue-item-status">{t("queue.waiting")}</div>}
                {item.status === "active" &&
                  (hasProgress ? (
                    <>
                      <div className="queue-progress-track">
                        <div className="queue-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="queue-item-meta">
                        <span>{pct}%</span>
                        <span>
                          {formatBytes(item.receivedBytes ?? 0)} / {formatBytes(item.totalBytes ?? 0)}
                        </span>
                        {speedBps > 0 && <span>{formatBytes(speedBps)}/s</span>}
                      </div>
                    </>
                  ) : (
                    <div className="queue-item-status">{t("queue.installing")}</div>
                  ))}
                {item.status === "done" && <div className="queue-item-status queue-status-done-text">✔ {t("queue.done")}</div>}
                {item.status === "error" && (
                  <div className="queue-item-status queue-status-error-text">✕ {item.message ?? t("queue.failed")}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!sptPath ? (
        <div className="empty-state">
          {/* Display name only. Deliberately NOT the package name, productName, or the
              executable filename - this is the title the app wears, not its identity.
              "Spicy Edition" is kept unbreakable so the header wraps as
              "SPTARKY MOD MANAGER / SPICY EDITION" rather than splitting the two words
              across lines, which is what plain wrapping does at this width. */}
          <h1>
            SPTarky Mod Manager <span className="title-unit">Spicy Edition</span>
          </h1>
          <p>{t("empty.selectFolder")}</p>
          <button onClick={handleSelectFolder}>{t("empty.selectFolderButton")}</button>
          <button onClick={handleOpenModHub}>{t("empty.downloadModsButton")}</button>
        </div>
      ) : (
        <div
          className="app"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingFile && (
            <div className="drop-overlay">
              <div className="drop-overlay-box">{t("dropOverlay.text")}</div>
            </div>
          )}
          <header>
            <div>
              {/* Display name only. Deliberately NOT the package name, productName, or the
              executable filename - this is the title the app wears, not its identity.
              "Spicy Edition" is kept unbreakable so the header wraps as
              "SPTARKY MOD MANAGER / SPICY EDITION" rather than splitting the two words
              across lines, which is what plain wrapping does at this width. */}
          <h1>
            SPTarky Mod Manager <span className="title-unit">Spicy Edition</span>
          </h1>
              {isSplitInstance ? (
                <span className="instance-path" title={`Client: ${sptPath}\nServer: ${serverRoot}`}>
                  {t("header.splitInstance", { client: sptPath ?? "", server: serverRoot ?? "" })}
                </span>
              ) : (
                <span className="instance-path" title={sptPath ?? ""}>{sptPath}</span>
              )}
            </div>
            <div className="header-actions">
              <button onClick={handleOpenBrowse} className="primary" title={t("header.browseForgeTitle")}>
                {t("header.browseForge")}
              </button>
              <button onClick={handleOpenModHub} title={t("header.openHubTitle")}>{t("header.openHub")}</button>
              {/* Two distinct things, so two buttons. A tracked server is on ANOTHER machine
                  and is reached over the network; a headless client is realistically always
                  on this one, since it is a folder the app has to read and write. Hiding
                  both behind one "Instances" button implied they were interchangeable. */}
              {multiMode ? (
                <button onClick={() => setMultiMode(false)} className="primary" title="Back to the single mod list">
                  Single view
                </button>
              ) : (
                <>
                  <button
                    onClick={handleServerButton}
                    title={
                      serverUrl
                        ? `Compare against the server at ${serverUrl}`
                        : "Track a live SPT server running on another machine (read only)"
                    }
                  >
                    {serverUrl ? "Server" : "Add server"}
                    <span className="btn-scope">remote</span>
                  </button>
                  <button
                    onClick={handleHeadlessButton}
                    title={
                      headlessPath
                        ? "Compare against the Fika headless client on this machine"
                        : "Track a Fika headless client installed on this machine"
                    }
                  >
                    {headlessPath ? "Headless" : "Add headless"}
                    <span className="btn-scope">local</span>
                  </button>
                </>
              )}
              <button
                onClick={openUpdatePanel}
                className={appUpdate?.updateAvailable ? "primary" : ""}
                title={
                  appUpdate?.updateAvailable
                    ? `Version ${appUpdate.latestVersion} is available — you have ${appUpdate.currentVersion}`
                    : "Update the mod manager, or switch to another version"
                }
              >
                {appUpdate?.updateAvailable ? `Update to ${appUpdate.latestVersion}` : "App version"}
              </button>
              <button onClick={handleSelectFolder} title={t("header.changeInstanceTitle")}>{t("header.changeInstance")}</button>
              <button onClick={handleInstall} disabled={loading} className="primary" title={t("header.installButtonTitle")}>
                {loading ? t("header.installing") : t("header.installButton")}
              </button>
            </div>
          </header>

          <div className="summary-bar">
            <span className="summary-item">
              <strong>{summary.total}</strong> {t("summary.total")}
            </span>
            <span className="summary-item">Server: <strong>{summary.server}</strong></span>
            <span className="summary-item">Client: <strong>{summary.client}</strong></span>
            <span className="summary-item summary-active">{t("summary.active")} <strong>{summary.active}</strong></span>
            <span className="summary-item summary-disabled">{t("summary.disabled")} <strong>{summary.disabled}</strong></span>
            {sptVersion && (
              <span className="summary-item" title={t("summary.versionTooltip")}>
                {sptVersion}
              </span>
            )}
            <span className="summary-item summary-valid" title={t("summary.validInstanceTitle")}>✔ {t("summary.validInstance")}</span>
          </div>

          {/* Search, filters, sorting and the Forge tools stay on screen in EVERY mode.
              An earlier version swapped them out when the split view opened, on the theory
              that they only applied to the main instance — which turned "show me both
              installs" into "lose the ability to search". They now apply to every pane. */}
          <input
            className="search-bar"
            type="text"
            placeholder={t("filters.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="filter-bar">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} title={t("filters.typeFilterTitle")}>
              <option value="all">{t("filters.typeAll")}</option>
              <option value="server">Server</option>
              <option value="client">Client</option>
              <option value="hybrid">Hybrid</option>
              <option value="unknown">Unknown</option>
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} title={t("filters.statusFilterTitle")}>
              <option value="all">{t("filters.statusAll")}</option>
              <option value="enabled">{t("filters.statusEnabled")}</option>
              <option value="disabled">{t("filters.statusDisabled")}</option>
            </select>
            <select value={originFilter} onChange={(e) => setOriginFilter(e.target.value as OriginFilter)} title={t("filters.originFilterTitle")}>
              <option value="all">{t("filters.originAll")}</option>
              <option value="manual">{t("filters.originManual")}</option>
              <option value="manager">{t("filters.originManager")}</option>
            </select>

            <span className="filter-separator" />

            <select value={sortField} onChange={(e) => setSortField(e.target.value as SortField)} title={t("filters.sortFieldTitle")}>
              <option value="name">{t("filters.sortByName")}</option>
              <option value="status">{t("filters.sortByStatus")}</option>
              <option value="origin">{t("filters.sortByOrigin")}</option>
              <option value="installedAt">{t("filters.sortByInstalledAt")}</option>
              <option value="forge">{t("filters.sortByForge")}</option>
            </select>
            <button onClick={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))} title={t("filters.sortDirectionTitle")}>
              {t(
                sortField === "installedAt"
                  ? sortDirection === "asc"
                    ? "filters.sortOldestFirst"
                    : "filters.sortNewestFirst"
                  : sortField === "name"
                    ? sortDirection === "asc"
                      ? "filters.sortAZ"
                      : "filters.sortZA"
                    : sortDirection === "asc"
                      ? "filters.sortAsc"
                      : "filters.sortDesc"
              )}
            </button>

            <span className="filter-separator" />

            <button onClick={selectAllVisible} title={t("filters.selectAllVisibleTitle")}>{t("filters.selectAllVisible")}</button>
            {selectedKeys.size > 0 && <button onClick={clearSelection}>{t("filters.clearSelection")}</button>}

            <span className="filter-separator" />

            <button
              onClick={presetsOpen ? () => setPresetsOpen(false) : openPresets}
              className={presetsOpen ? "primary" : ""}
              title="Save this setup as a preset, or compare against one you have saved"
            >
              {presetsOpen ? "Hide presets" : "Presets"}
            </button>
            <button
              onClick={addonsOpen ? () => setAddonsOpen(false) : openAddons}
              className={addonsOpen ? "primary" : ""}
              title="Compatibility and companion mods for what you have installed"
            >
              {addonsOpen ? "Hide addons" : "Addons"}
            </button>
            <button onClick={openBulkReinstall} title="Re-download every installed mod at its latest version">
              Reinstall all
            </button>
            <button onClick={handleExportList} title={t("filters.exportListTitle")}>{t("filters.exportList")}</button>
            <button onClick={handleImportList} title={t("filters.importCompareTitle")}>{t("filters.importCompare")}</button>
            <button onClick={handleDetectConflicts} disabled={checkingConflicts} title={t("filters.checkConflictsTitle")}>
              {checkingConflicts ? t("filters.checkingConflicts") : t("filters.checkConflicts")}
            </button>
            <span className="filter-separator"></span>
            <select
              className="version-input"
              value={sptVersionInput}
              onChange={(e) => {
                setSptVersionInput(e.target.value);
                window.modManagerAPI.setSptVersionOverride(e.target.value);
              }}
              title={t("filters.sptVersionTitle")}
            >
              <option value="">{t("filters.sptVersionPlaceholder")}</option>
              {forgeSptVersions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version} ({v.modCount} mods)
                </option>
              ))}
              {sptVersionInput && !forgeSptVersions.some((v) => v.version === sptVersionInput) && (
                <option value={sptVersionInput}>{sptVersionInput} {t("filters.sptVersionNotListed")}</option>
              )}
            </select>
            <button
              onClick={handleCheckForgeUpdates}
              disabled={checkingForgeUpdates}
              title={t("filters.forgeCheckTitle")}
            >
              {checkingForgeUpdates
                ? forgeProgress && forgeProgress.total > 0
                  ? t("filters.forgeCheckingProgress", { done: forgeProgress.done, total: forgeProgress.total })
                  : t("filters.forgeChecking")
                : t("filters.forgeCheckButton")}
            </button>
          </div>

          {forgeCheckedAt && (
            <p className="sort-hint">
              {t("hint.forgeLastChecked", { date: new Date(forgeCheckedAt).toLocaleString(lang) })}
            </p>
          )}


          {compareResult && (
            <div className="compare-panel">
              <div className="compare-header">
                <strong>{t("compare.title")}</strong>
                <button onClick={() => setCompareResult(null)}>{t("common.close")}</button>
              </div>
              {compareResult.missing.length === 0 && compareResult.extra.length === 0 ? (
                <p>{t("compare.identical")}</p>
              ) : (
                <>
                  {compareResult.missing.length > 0 && (
                    <p>
                      <strong>{t("compare.missing", { count: compareResult.missing.length })}</strong> {compareResult.missing.join(", ")}
                    </p>
                  )}
                  {compareResult.extra.length > 0 && (
                    <p>
                      <strong>{t("compare.extra", { count: compareResult.extra.length })}</strong> {compareResult.extra.join(", ")}
                    </p>
                  )}
                </>
              )}
              <p className="compare-note">{t("compare.note")}</p>
            </div>
          )}

          {conflictReport && (
            <div className="compare-panel">
              <div className="compare-header">
                <strong>{t("conflicts.title")}</strong>
                <button onClick={() => setConflictReport(null)}>{t("common.close")}</button>
              </div>
              {conflictReport.clientFileConflicts.length === 0 &&
              conflictReport.duplicateServerNames.length === 0 &&
              (conflictReport.duplicateClientMods?.length ?? 0) === 0 ? (
                <p>{t("toast.noConflictsFound")}</p>
              ) : (
                <>
                  {conflictReport.clientFileConflicts.map((c) => (
                    <p key={`dll-${c.fileName}`}>
                      <strong>DLL "{c.fileName}"</strong> {t("conflicts.appearsIn")} {c.mods.join(", ")}
                    </p>
                  ))}
                  {(conflictReport.duplicateClientMods ?? []).map((d) => (
                    <p key={`client-dup-${d.declaredName}`}>
                      <strong>{t("conflicts.sameModTwice")}</strong> {d.mods.join(", ")}
                    </p>
                  ))}
                  {conflictReport.duplicateServerNames.map((d) => (
                    <p key={`name-${d.declaredName}`}>
                      <strong>{t("conflicts.nameLabel")} "{d.declaredName}"</strong> {t("conflicts.declaredInMultiple")} {d.mods.join(", ")}
                    </p>
                  ))}
                </>
              )}
              <p className="compare-note">{t("conflicts.note")}</p>
            </div>
          )}

          {forgeError && (
            <div className="compare-panel">
              <div className="compare-header">
                <strong>{t("forge.checkTitle")}</strong>
                <button onClick={() => setForgeError(null)}>{t("common.close")}</button>
              </div>
              <p>{forgeError}</p>
            </div>
          )}

          {forgeResult && (
            <div className="compare-panel">
              <div className="compare-header">
                <strong>{t("forge.checkTitle")} — SPT {forgeResult.sptVersionUsed}</strong>
                <button onClick={() => setForgeResult(null)}>{t("common.close")}</button>
              </div>
              {forgeResult.updates.length > 0 && (
                <>
                  <p><strong>{t("forge.updatesAvailable")}</strong></p>
                  {forgeResult.updates.map((u) => (
                    <p key={`update-${u.name}`}>
                      {u.name}: {u.currentVersion} → <strong>{u.recommendedVersion}</strong>
                      {u.downloadLink && (
                        <>
                          {" "}
                          <button
                            className="primary inline-update-button"
                            disabled={updatingModName === u.name}
                            onClick={() => handleInstallUpdate(u.name, u.downloadLink!, u.recommendedVersion, u.guid)}
                          >
                            {updatingModName === u.name ? t("forge.updating") : t("forge.updateNow")}
                          </button>
                        </>
                      )}
                      {u.originalName && u.recommendedVersion && (
                        <>
                          {" "}
                          <button
                            className="inline-update-button"
                            title={t("forge.dismissTitle")}
                            onClick={() => dismissUpdate(u.originalName!, u.recommendedVersion!, u.name)}
                          >
                            {t("forge.dismiss")}
                          </button>
                        </>
                      )}
                    </p>
                  ))}
                </>
              )}
              {forgeResult.blocked.length > 0 && (
                <>
                  <p><strong>{t("forge.blockedTitle")}</strong></p>
                  {forgeResult.blocked.map((b) => (
                    <p key={`blocked-${b.name}`}>
                      {b.name}: {b.currentVersion} — {b.reason}
                    </p>
                  ))}
                </>
              )}
              {forgeResult.incompatible.length > 0 && (
                <>
                  <p><strong>{t("forge.incompatibleTitle")}</strong></p>
                  {forgeResult.incompatible.map((i) => (
                    <p key={`incompatible-${i.name}`}>{i.name} ({i.currentVersion})</p>
                  ))}
                </>
              )}
              {forgeResult.infoOnly.length > 0 && (
                <>
                  <p><strong>{t("forge.infoOnlyTitle")}</strong></p>
                  {forgeResult.infoOnly.map((info) => (
                    <p key={`info-${info.name}`}>{info.name}: {t("forge.infoHasVersion", { version: info.recommendedVersion ?? "" })}</p>
                  ))}
                </>
              )}
              {forgeResult.updates.length === 0 &&
                forgeResult.blocked.length === 0 &&
                forgeResult.incompatible.length === 0 &&
                forgeResult.infoOnly.length === 0 && (
                <p>{t("forge.allUpToDateDetailed")}</p>
              )}
              {(forgeResult.skippedByBudget?.length ?? 0) > 0 && (
                <p className="compare-note">
                  {t("forge.skippedByBudget", { count: forgeResult.skippedByBudget!.length })}
                </p>
              )}
              {forgeResult.unmatched.length > 0 && (
                <p className="compare-note">
                  {t("forge.unmatchedPrefix")} {forgeResult.unmatched.join(", ")}
                </p>
              )}
              {(forgeResult.unconfirmed?.length ?? 0) > 0 && (
                <div className="unconfirmed-block">
                  <p><strong>{t("forge.unconfirmedTitle")}</strong></p>
                  <p className="compare-note">{t("forge.unconfirmedExplain")}</p>
                  {forgeResult.unconfirmed!.map((u) => (
                    <div className="unconfirmed-row" key={`unconfirmed-${u.originalName}`}>
                      <div className="unconfirmed-info">
                        <span className="unconfirmed-mod">{u.name}</span>
                        <span className="unconfirmed-arrow">→</span>
                        <button
                          className="link-button"
                          onClick={() => window.modManagerAPI.openReleasePage(u.detailUrl)}
                          title={t("forge.unconfirmedOpenTitle")}
                        >
                          {u.forgeName ?? `#${u.modId}`}
                        </button>
                        <span className="package-chip">{u.method}</span>
                      </div>
                      <div className="unconfirmed-actions">
                        <button onClick={() => confirmForgeMatch(u.originalName, u.modId, u.forgeName ?? String(u.modId))}>
                          {t("forge.unconfirmedConfirm")}
                        </button>
                        <button onClick={() => relinkForgeMatch(u.originalName, u.name)}>
                          {t("forge.unconfirmedRelink")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="compare-note">{t("forge.matchNote")}</p>
            </div>
          )}

          {selectedKeys.size > 0 && (
            <div className="bulk-bar">
              <span>{t("bulk.selectedCount", { count: selectedKeys.size })}</span>
              <div className="bulk-actions">
                <button onClick={() => runBulk("enable")} disabled={mutating}>{t("bulk.enable")}</button>
                <button onClick={() => runBulk("disable")} disabled={mutating}>{t("bulk.disable")}</button>
                <button onClick={() => runBulk("remove")} className="danger" disabled={mutating}>{t("bulk.remove")}</button>
                <button onClick={clearSelection}>{t("bulk.cancelSelection")}</button>
              </div>
            </div>
          )}

          {filtersActive && filteredMods.length === 0 && mods.length > 0 && (
            <div className="no-results">
              {t("noResults.text")}
              <button onClick={clearFilters}>{t("noResults.clearFilters")}</button>
            </div>
          )}

          {addonsOpen && (
            <AddonsPanel
              suggestions={addonSuggestions}
              links={addonLinks}
              integrations={addonIntegrations}
              mods={mods}
              busy={addonBusy}
              scanned={addonsScanned}
              catalogueSize={addonCatalogueSize}
              onInstallForgeAddon={handleInstallForgeAddon}
              onInstallFromFile={handleInstallAddonFromFile}
              onDetectLinks={handleDetectAddonLinks}
              onSetParent={handleSetAddonParent}
              onClose={() => setAddonsOpen(false)}
            />
          )}

          {presetsOpen && (
            <PresetsPanel
              presets={presets}
              selectedId={selectedPresetId}
              report={presetReport}
              busy={presetBusy}
              storeStatus={storeStatus}
              identity={presetIdentity}
              storeUsage={storeUsage}
              payloadProgress={payloadProgress}
              onSelect={handleSelectPreset}
              onSaveCurrent={handleSavePreset}
              onRecapture={handleRecapturePreset}
              onDelete={handleDeletePreset}
              onApplyState={handleApplyPresetState}
              onChooseStore={handleChooseStore}
              onCreateStore={handleCreateStore}
              onDisconnectStore={handleDisconnectStore}
              onSetIdentity={handleSetIdentity}
              onSetStorePolicy={handleSetStorePolicy}
              onPublish={handlePublishPreset}
              onUnpublish={handleUnpublishPreset}
              onImportFromStore={handleImportFromStore}
              onExportFile={handleExportPresetFile}
              onImportFile={handleImportPresetFile}
              onPublishWithPayloads={handlePublishWithPayloads}
              onInstallPayloads={handleInstallPayloads}
              onVerifyPayloads={handleVerifyPayloads}
              onCleanStore={handleCleanStore}
              onCancelPayloads={handleCancelPayloads}
              onClose={() => setPresetsOpen(false)}
            />
          )}

          {/* Only the mod LIST swaps between modes — everything above stays put. */}
          {multiMode ? (
            <InstancesView
              mainPath={sptPath}
              headlessPath={headlessData?.headlessPath ?? headlessPath}
              mainMods={applyFilterSort(headlessData?.mainMods ?? mods)}
              headlessMods={applyFilterSort(headlessData?.headlessMods ?? [])}
              parity={headlessData?.parity ?? null}
              server={serverSync}
              serverUrl={serverUrl}
              filtersActive={filtersActive}
              overrides={headlessOverrides}
              onOverride={handleHeadlessOverride}
              onToggle={handleInstanceToggle}
              onUninstall={handleInstanceUninstall}
              onOpenFolder={handleInstanceOpenFolder}
              onChangeHeadless={handleSelectHeadlessFolder}
              onChangeServer={() => setServerPrompt(true)}
              onClearServer={handleClearServer}
              onExitMultiMode={() => setMultiMode(false)}
              onRefresh={() => void refreshMulti()}
              refreshing={multiRefreshing}
              searchQuery={searchQuery}
              onSyncMod={handleSyncMod}
              onSyncAll={handleSyncAll}
              onRemoveFromHeadless={handleRemoveFromHeadless}
              syncing={syncing}
              headlessConfigured={!!headlessPath}
              onInstallFromServer={handleInstallFromServer}
              installingFromServer={installingFromServer}
            />
          ) : (
            <>
              <Section title="Server Mods" mods={filteredMods.filter((m) => m.type === "server")} {...listProps} />
              <Section title="Client Mods" mods={filteredMods.filter((m) => m.type === "client")} {...listProps} />
              {mods.some((m) => m.type === "hybrid" || m.type === "unknown") && (
                <Section
                  title="Hybrid / Unknown"
                  mods={filteredMods.filter((m) => m.type === "hybrid" || m.type === "unknown")}
                  {...listProps}
                />
              )}
            </>
          )}
        </div>
      )}

      {browseOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setBrowseOpen(false); }}>
          <div className="modal-box forge-browse-modal">
            <div className="modal-header">
              <strong>{t("browse.title")}</strong>
              <button onClick={() => setBrowseOpen(false)} title={t("common.close")}>✕</button>
            </div>

            <div className="forge-browse-controls">
              <input
                type="text"
                placeholder={t("browse.searchPlaceholder")}
                value={browseQuery}
                onChange={(e) => setBrowseQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runForgeSearch(1); }}
              />
              <select value={browseCategory} onChange={(e) => setBrowseCategory(e.target.value)} title={t("browse.categoryFilterTitle")}>
                <option value="">{t("browse.allCategories")}</option>
                {browseCategories.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.title}</option>
                ))}
              </select>
              <label className="forge-browse-checkbox" title={t("browse.compatibleOnlyTitle")}>
                <input
                  type="checkbox"
                  checked={browseOnlyCompatible}
                  onChange={(e) => setBrowseOnlyCompatible(e.target.checked)}
                  disabled={!sptVersionInput.trim()}
                />
                {t("browse.compatibleOnlyLabel", { version: sptVersionInput.trim() || t("browse.selectVersionPlaceholder") })}
              </label>
              <button onClick={() => runForgeSearch(1)} disabled={browseLoading} className="primary">
                {browseLoading ? t("browse.searching") : t("browse.searchButton")}
              </button>
            </div>

            {browseError && <p className="compare-note">{browseError}</p>}

            <div className="forge-browse-results">
              {!browseLoading && browseResults.length === 0 && !browseError && (
                <p className="compare-note">{t("browse.noResults")}</p>
              )}
              {browseResults.map((mod) => {
                const selectedId = selectedVersionByModId.get(mod.id) ?? mod.versions[0]?.id;
                return (
                  <div key={mod.id} className="forge-mod-card">
                    {mod.thumbnail ? (
                      <img
                        src={mod.thumbnail}
                        alt=""
                        className="forge-mod-thumb"
                        loading="lazy"
                        decoding="async"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                          e.currentTarget.nextElementSibling?.classList.remove("forge-mod-thumb-hidden");
                        }}
                      />
                    ) : null}
                    <div className={`forge-mod-thumb forge-mod-thumb-placeholder ${mod.thumbnail ? "forge-mod-thumb-hidden" : ""}`} />
                    <div className="forge-mod-info">
                      <div className="forge-mod-title-row">
                        <a href={mod.detailUrl} onClick={(e) => { e.preventDefault(); window.modManagerAPI.openModHub(); }} title={t("browse.viewOnForgeTitle")}>
                          {mod.name}
                        </a>
                        {mod.category && <span className="meta-chip">{mod.category}</span>}
                        {mod.fikaCompatible && <span className="meta-chip forge-chip-update" title={t("browse.fikaCompatibleTitle")}>Fika</span>}
                      </div>
                      {mod.teaser && <p className="forge-mod-teaser">{mod.teaser}</p>}
                      <div className="forge-mod-meta">
                        {mod.author && <span>{t("browse.byAuthor", { author: mod.author })}</span>}
                        <span>{mod.downloads.toLocaleString(lang)} {t("browse.downloadsLabel")}</span>
                      </div>
                    </div>
                    <div className="forge-mod-install">
                      {mod.versions.length > 0 ? (
                        <>
                          <select
                            value={selectedId}
                            onChange={(e) => handleSelectVersion(mod.id, Number(e.target.value))}
                            title={t("browse.chooseVersionTitle")}
                          >
                            {mod.versions.map((v) => (
                              <option key={v.id} value={v.id}>
                                v{v.version}{v.sptConstraint ? ` (SPT ${v.sptConstraint})` : ""}
                              </option>
                            ))}
                          </select>
                          <button onClick={() => handleInstallFromForge(mod)} disabled={installingModId === mod.id} className="primary">
                            {installingModId === mod.id ? t("browse.installing") : t("browse.installButton")}
                          </button>
                        </>
                      ) : (
                        <span className="forge-mod-no-version">{t("browse.noVersionPublishedShort")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {browseLastPage > 1 && (
              <div className="forge-browse-pagination">
                <button onClick={() => runForgeSearch(browsePage - 1)} disabled={browsePage <= 1 || browseLoading}>{t("browse.prevPage")}</button>
                <span>{t("browse.pageOf", { page: browsePage, lastPage: browseLastPage })}</span>
                <button onClick={() => runForgeSearch(browsePage + 1)} disabled={browsePage >= browseLastPage || browseLoading}>{t("browse.nextPage")}</button>
              </div>
            )}

            <p className="compare-note">{t("browse.installNote")}</p>
          </div>
        </div>
      )}

      {pendingConfirm && (
        <div className="modal-backdrop">
          <div className="modal-box confirm-structure-modal">
            <div className="modal-header">
              <strong>{t("confirm.title")}</strong>
            </div>
            <p className="compare-note">
              {t("confirm.descriptionPrefix")} <code>package.json</code> {t("confirm.descriptionMid")} <code>user</code>/<code>BepInEx</code> {t("confirm.descriptionSuffix")}
            </p>
            <ul className="confirm-structure-list">
              {pendingConfirm.rootEntries.length > 0 ? (
                pendingConfirm.rootEntries.map((entry) => <li key={entry}>{entry}</li>)
              ) : (
                <li className="empty-list">{t("confirm.emptyArchive")}</li>
              )}
            </ul>
            <p className="compare-note">{t("confirm.explanation")}</p>
            <div className="confirm-structure-actions">
              <button onClick={handleConfirmAbort}>{t("confirm.abort")}</button>
              <button onClick={handleConfirmProceed} className="primary">{t("confirm.proceed")}</button>
            </div>
          </div>
        </div>
      )}

      {bulkOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !bulkRunning) setBulkOpen(false);
          }}
        >
          <div className="modal-box bulk-modal">
            <div className="modal-header">
              <strong>Reinstall every mod</strong>
              <button onClick={() => setBulkOpen(false)} disabled={bulkRunning} title={t("common.close")}>✕</button>
            </div>

            {bulkResult ? (
              <>
                <p className="compare-note">{bulkResult.message}</p>
                {bulkResult.counts && (
                  <ul className="bulk-counts">
                    <li className="ok">{bulkResult.counts.reinstalled} reinstalled</li>
                    {bulkResult.counts.notFound > 0 && <li className="warn">{bulkResult.counts.notFound} not found</li>}
                    {bulkResult.counts.failed > 0 && <li className="bad">{bulkResult.counts.failed} failed</li>}
                  </ul>
                )}
                {(bulkResult.outcomes ?? []).filter((o) => o.status !== "reinstalled").length > 0 && (
                  <ul className="bulk-outcomes">
                    {(bulkResult.outcomes ?? [])
                      .filter((o) => o.status !== "reinstalled")
                      .map((o) => (
                        <li key={o.name}>
                          <span className={`bulk-status bulk-${o.status}`}>{o.status === "not-found" ? "not found" : o.status}</span>
                          <span className="bulk-name">{o.name}</span>
                          {o.detail && <span className="bulk-detail">{o.detail}</span>}
                        </li>
                      ))}
                  </ul>
                )}
                <div className="confirm-structure-actions">
                  <button onClick={() => setBulkOpen(false)} className="primary">Done</button>
                </div>
              </>
            ) : !bulkPreview ? (
              <p className="empty-list">Checking the install…</p>
            ) : (
              <>
                <p className="bulk-warning">
                  This re-downloads and replaces <strong>all {bulkPreview.modCount} installed mods</strong> with the
                  latest version for SPT {bulkPreview.sptVersion ?? "?"}. It is the most destructive thing this app does.
                </p>

                {/* Forge dies on 2026-08-10; GitHub does not. Offering both is what keeps
                    this feature working afterwards. */}
                <div className="bulk-source">
                  <label className={bulkSource === "forge" ? "active" : ""}>
                    <input
                      type="radio"
                      checked={bulkSource === "forge"}
                      onChange={() => setBulkSource("forge")}
                      disabled={bulkRunning}
                    />
                    <span>
                      <strong>Forge</strong>
                      <em>Resolves all {bulkPreview.modCount} in one batched pass. Stops working after 10 August.</em>
                    </span>
                  </label>
                  <label className={bulkSource === "github" ? "active" : ""}>
                    <input
                      type="radio"
                      checked={bulkSource === "github"}
                      onChange={() => setBulkSource("github")}
                      disabled={bulkRunning}
                    />
                    <span>
                      <strong>GitHub</strong>
                      <em>
                        {bulkPreview.withRepo ?? 0} of {bulkPreview.modCount} have a known repository. Keeps working
                        after Forge closes, but GitHub allows only 60 requests an hour without a token — one run uses
                        most of that.
                      </em>
                    </span>
                  </label>
                </div>

                <ul className="bulk-facts">
                  <li>
                    <strong>Your configuration is protected.</strong> {bulkPreview.configDirs} config location(s) are
                    backed up first and restored afterwards — including presets kept inside a mod's own folder, like
                    SAIN's. The backup is left on disk either way.
                  </li>
                  <li>
                    <strong>Mods that can't be found are left alone</strong>, never removed.
                  </li>
                  <li>
                    <strong>{bulkPreview.withoutRecord} mod(s) currently have no recorded version</strong> — the app only
                    knows what they claim about themselves. Reinstalling records what was actually downloaded.
                  </li>
                  <li className="bulk-deadline">
                    <strong>Forge shuts down on 10 August 2026.</strong> After that this cannot re-download anything. If
                    a bulk run goes wrong afterwards, there is nowhere to fetch from — so do this while there is still
                    time to recover, or not at all.
                  </li>
                </ul>

                {bulkRunning ? (
                  <div className="bulk-progress">
                    <p className="compare-note">
                      {bulkProgress?.phase === "backup"
                        ? "Backing up configuration…"
                        : bulkProgress?.phase === "resolve"
                          ? `Looking mods up… ${bulkProgress.done}/${bulkProgress.total}`
                          : bulkProgress?.phase === "restore"
                            ? "Restoring configuration…"
                            : bulkProgress
                              ? `Installing ${bulkProgress.done}/${bulkProgress.total}${bulkProgress.current ? ` — ${bulkProgress.current}` : ""}`
                              : "Starting…"}
                    </p>
                    {bulkProgress && bulkProgress.total > 0 && (
                      <div className="bulk-progress-bar">
                        <div style={{ width: `${Math.round((100 * bulkProgress.done) / bulkProgress.total)}%` }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <p className="compare-note">
                      Type <code>REINSTALL</code> to confirm.
                    </p>
                    <input
                      type="text"
                      value={bulkConfirmText}
                      placeholder="REINSTALL"
                      onChange={(e) => setBulkConfirmText(e.target.value)}
                    />
                  </>
                )}

                <div className="confirm-structure-actions">
                  <button onClick={() => setBulkOpen(false)} disabled={bulkRunning}>{t("common.cancel")}</button>
                  <button
                    onClick={runBulkReinstall}
                    className="primary"
                    disabled={bulkRunning || bulkConfirmText.trim().toUpperCase() !== "REINSTALL"}
                  >
                    {bulkRunning ? "Reinstalling…" : `Reinstall ${bulkPreview.modCount} mods`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {updatePanelOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !installingApp) setUpdatePanelOpen(false);
          }}
        >
          <div className="modal-box update-modal">
            <div className="modal-header">
              <strong>Mod manager version</strong>
              <button onClick={() => setUpdatePanelOpen(false)} disabled={installingApp} title={t("common.close")}>
                ✕
              </button>
            </div>

            <p className="compare-note">
              Running <code>{appVersionRunning || "?"}</code>. Pick a version and it will be downloaded from the
              repository and swapped in. Your current copy is kept as a backup and put back automatically if the new one
              fails to start. Settings, mods and instance paths are untouched.
            </p>

            {loadingReleases ? (
              <p className="empty-list">Fetching releases…</p>
            ) : releasesError ? (
              <p className="hl-server-error">{releasesError}</p>
            ) : appReleases.length === 0 ? (
              <p className="empty-list">No releases found.</p>
            ) : (
              <>
                <select
                  className="version-input update-select"
                  value={selectedRelease}
                  onChange={(e) => setSelectedRelease(e.target.value)}
                  disabled={installingApp}
                >
                  {appReleases.map((r) => (
                    <option key={r.tag} value={r.tag} disabled={!r.assetUrl}>
                      {r.version}
                      {r.isCurrent ? "  (current)" : ""}
                      {r.prerelease ? "  (pre-release)" : ""}
                      {!r.assetUrl ? "  — no download attached" : r.assetSize ? `  — ${formatBytes(r.assetSize)}` : ""}
                    </option>
                  ))}
                </select>

                {(() => {
                  const r = appReleases.find((x) => x.tag === selectedRelease);
                  if (!r) return null;
                  const direction = r.isCurrent
                    ? "reinstall"
                    : compareSemver(r.version, appVersionRunning) < 0
                      ? "downgrade"
                      : "upgrade";
                  return (
                    <p className={`update-direction update-${direction}`}>
                      {direction === "downgrade"
                        ? `Going back from ${appVersionRunning} to ${r.version}.`
                        : direction === "reinstall"
                          ? `Reinstalling ${r.version}.`
                          : `Updating from ${appVersionRunning} to ${r.version}.`}
                      {r.publishedAt ? ` Published ${new Date(r.publishedAt).toLocaleDateString(lang)}.` : ""}
                    </p>
                  );
                })()}
              </>
            )}

            {updateProgress && updateProgress.total > 0 && (
              <p className="compare-note">
                Downloading… {formatBytes(updateProgress.received)} of {formatBytes(updateProgress.total)} (
                {Math.round((100 * updateProgress.received) / updateProgress.total)}%)
              </p>
            )}

            <div className="confirm-structure-actions">
              <button onClick={() => setUpdatePanelOpen(false)} disabled={installingApp}>
                {t("common.cancel")}
              </button>
              <button
                onClick={handleInstallAppRelease}
                className="primary"
                disabled={installingApp || !selectedRelease || !appReleases.find((r) => r.tag === selectedRelease)?.assetUrl}
              >
                {installingApp ? "Installing…" : "Install this version"}
              </button>
            </div>
          </div>
        </div>
      )}

      {serverPrompt && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setServerPrompt(false);
          }}
        >
          <div className="modal-box relink-modal">
            <div className="modal-header">
              <strong>Connect to an SPT server</strong>
              <button onClick={() => setServerPrompt(false)} title={t("common.close")}>✕</button>
            </div>
            <p className="compare-note">
              The address of a running SPT server. It is read only — the app compares your mods against it and never
              writes to it. SPT 4.x uses HTTPS on port 6969, and its certificate is self-signed, which is expected.
            </p>
            <input
              type="text"
              autoFocus
              value={serverInput}
              placeholder="192.168.1.78:6969"
              onChange={(e) => setServerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitServerUrl();
                if (e.key === "Escape") setServerPrompt(false);
              }}
            />
            <div className="confirm-structure-actions">
              <button onClick={() => setServerPrompt(false)}>{t("common.cancel")}</button>
              <button onClick={() => void submitServerUrl()} className="primary" disabled={!serverInput.trim()}>
                Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {relinkTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRelinkTarget(null);
          }}
        >
          <div className="modal-box relink-modal">
            <div className="modal-header">
              <strong>{t("forge.relinkTitle", { name: relinkTarget.displayName })}</strong>
              <button onClick={() => setRelinkTarget(null)} title={t("common.close")}>✕</button>
            </div>
            <p className="compare-note">{t("forge.relinkHelp")}</p>
            <input
              type="text"
              autoFocus
              value={relinkInput}
              placeholder="https://forge.sp-tarkov.com/mod/791/sain    or    791"
              onChange={(e) => setRelinkInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRelink();
                if (e.key === "Escape") setRelinkTarget(null);
              }}
            />
            <div className="confirm-structure-actions">
              <button onClick={() => setRelinkTarget(null)}>{t("common.cancel")}</button>
              <button onClick={submitRelink} className="primary" disabled={!relinkInput.trim()}>
                {t("forge.relinkSave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({
  title,
  mods,
  ...listProps
}: { title: string; mods: ModInfo[] } & Omit<Parameters<typeof ModList>[0], "mods">) {
  return (
    <section>
      <h2>{title} ({mods.length})</h2>
      <ModList mods={mods} {...listProps} />
    </section>
  );
}

function ModList({
  mods,
  onToggle,
  onUninstall,
  onOpenFolder,
  onReinstall,
  onRenameStart,
  onRenameCancel,
  onRenameConfirm,
  editingKey,
  editingValue,
  onEditingValueChange,
  selectedKeys,
  onToggleSelect,
  onRangeSelect,
  openMenuKey,
  onSetOpenMenuKey,
  disabled = false,
  forgeStatusByName,
  packagePartsById,
  t
}: {
  mods: ModInfo[];
  onToggle: (mod: ModInfo) => void;
  onUninstall: (mod: ModInfo) => void;
  onOpenFolder: (mod: ModInfo) => void;
  onReinstall: (mod: ModInfo) => void;
  onRenameStart: (mod: ModInfo) => void;
  onRenameCancel: () => void;
  onRenameConfirm: (mod: ModInfo) => void;
  editingKey: string | null;
  editingValue: string;
  onEditingValueChange: (value: string) => void;
  selectedKeys: Set<string>;
  onToggleSelect: (mod: ModInfo) => void;
  onRangeSelect: (keys: string[]) => void;
  openMenuKey: string | null;
  onSetOpenMenuKey: (key: string | null) => void;
  disabled?: boolean;
  forgeStatusByName?: Map<string, { status: "update" | "blocked" | "incompatible" | "info"; version?: string }>;
  packagePartsById?: Map<string, ModInfo[]>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  if (mods.length === 0) {
    return <p className="empty-list">{t("modlist.emptyCategory")}</p>;
  }

  function handleCheckboxClick(e: ReactMouseEvent<HTMLInputElement>, mod: ModInfo, index: number) {
    if (e.shiftKey && lastClickedIndex !== null) {
      const [start, end] = lastClickedIndex < index ? [lastClickedIndex, index] : [index, lastClickedIndex];
      onRangeSelect(mods.slice(start, end + 1).map(selectionKey));
    } else {
      onToggleSelect(mod);
    }
    setLastClickedIndex(index);
  }

  return (
    <ul className="mod-list">
      {mods.map((mod, index) => {
        const key = selectionKey(mod);
        const isEditing = editingKey === key;
        const isMenuOpen = openMenuKey === key;
        const forgeStatus = forgeStatusByName?.get(mod.name);
        return (
          <li key={key} className={`mod-item ${mod.enabled ? "" : "disabled"}`}>
            <input
              type="checkbox"
              checked={selectedKeys.has(key)}
              onClick={(e) => handleCheckboxClick(e, mod, index)}
              onChange={() => {}}
              className="mod-checkbox"
              disabled={disabled}
              title={t("modlist.checkboxTitle")}
            />
            <span className="mod-number">{String(index + 1).padStart(2, "0")}</span>
            <div className="mod-info">
              {isEditing ? (
                <input
                  className="rename-input"
                  autoFocus
                  value={editingValue}
                  onChange={(e) => onEditingValueChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRenameConfirm(mod);
                    if (e.key === "Escape") onRenameCancel();
                  }}
                  onBlur={() => onRenameConfirm(mod)}
                />
              ) : (
                <span className="mod-name" title={t("modlist.renameTitle", { name: mod.originalName })} onDoubleClick={() => onRenameStart(mod)}>
                  {mod.name}
                </span>
              )}
              <div className="mod-meta">
                <span className={`type-badge type-${mod.type}`}>{mod.type}</span>
                <span className={`status-chip ${mod.enabled ? "status-chip-on" : "status-chip-off"}`}>
                  {mod.enabled ? t("modlist.statusActive") : t("modlist.statusDisabled")}
                </span>
                <span className="origin-chip">{mod.installedManually ? "Manual" : "Manager"}</span>
                {/* Where the version came from is worth showing, because they are not
                    equally trustworthy. A recorded version is what the app installed; a mod
                    that never updates its own version string cannot contradict it. */}
                {mod.version && (
                  <span
                    className={`meta-chip${mod.versionSource === "recorded" ? " version-recorded" : ""}${
                      mod.versionSource === "stale-record" ? " version-stale" : ""
                    }`}
                    title={
                      mod.versionSource === "recorded"
                        ? `Installed by this app${mod.versionEvidence ? ` — ${mod.versionEvidence}` : ""}.` +
                          (mod.declaredVersion ? `\n\nThe mod itself still claims ${mod.declaredVersion}; its author does not maintain that field.` : "")
                        : mod.versionSource === "stale-record"
                          ? "The files have changed since this app installed the mod, so its own declared version is shown instead."
                          : mod.versionSource === "sibling"
                            ? "Taken from another part of the same package."
                            : mod.versionSource === "assembly"
                              ? "Read from the compiled assembly — may be stale."
                              : "Declared by the mod."
                    }
                  >
                    v{mod.version}
                    {mod.declaredVersion && <em className="version-disputed"> ≠ {mod.declaredVersion}</em>}
                  </span>
                )}
                {mod.author && <span className="meta-chip">{t("browse.byAuthor", { author: mod.author })}</span>}
                {forgeStatus?.status === "update" && (
                  <span className="meta-chip forge-chip-update" title={t("modlist.forgeUpdateAvailableTitle")}>
                    {t("modlist.forgeUpdateAvailable", { version: forgeStatus.version ?? "" })}
                  </span>
                )}
                {forgeStatus?.status === "blocked" && (
                  <span className="meta-chip forge-chip-blocked" title={t("modlist.forgeBlockedTitle")}>
                    {t("modlist.forgeBlocked")}
                  </span>
                )}
                {forgeStatus?.status === "incompatible" && (
                  <span className="meta-chip forge-chip-incompatible" title={t("modlist.forgeIncompatibleTitle")}>
                    {t("modlist.forgeIncompatible")}
                  </span>
                )}
                {forgeStatus?.status === "info" && (
                  <span className="meta-chip forge-chip-info" title={t("modlist.forgeInfoTitle")}>
                    {t("modlist.forgeInfo", { version: forgeStatus.version ?? "" })}
                  </span>
                )}
                {mod.sptCompatibility === "incompatible" && (
                  <span
                    className="meta-chip forge-chip-incompatible"
                    title={t("modlist.sptIncompatibleTitle", { declared: mod.sptVersion ?? "" })}
                  >
                    {t("modlist.sptIncompatible")}
                  </span>
                )}
                {(() => {
                  const parts = mod.packageId ? packagePartsById?.get(mod.packageId) : undefined;
                  if (!parts || parts.length < 2) return null;
                  const others = parts.filter((x) => selectionKey(x) !== key).map((x) => `${x.name} (${x.type})`);
                  return (
                    <span
                      className="meta-chip package-chip"
                      title={t(
                        mod.packageId?.startsWith("inferred:") ? "modlist.packageTooltipInferred" : "modlist.packageTooltip",
                        { others: others.join(", ") }
                      )}
                    >
                      {t("modlist.packagePart", { count: parts.length })}
                    </span>
                  );
                })()}
                {mod.manifestOnly && (
                  <span className="meta-chip" title={t("modlist.orphanTitle")}>
                    {t("modlist.orphan")}
                  </span>
                )}
              </div>
            </div>
            <div className="action-menu-wrapper">
              <button className="menu-trigger" onClick={() => onSetOpenMenuKey(isMenuOpen ? null : key)} title={t("modlist.actionsTitle")} disabled={disabled}>
                ⋮
              </button>
              {isMenuOpen && (
                <div className="action-menu">
                  {!mod.manifestOnly && (
                    <button onClick={() => { onToggle(mod); onSetOpenMenuKey(null); }}>
                      {mod.enabled ? t("bulk.disable") : t("bulk.enable")}
                    </button>
                  )}
                  {!mod.manifestOnly && (
                    <button onClick={() => { onOpenFolder(mod); onSetOpenMenuKey(null); }}>{t("modlist.openFolder")}</button>
                  )}
                  <button onClick={() => onRenameStart(mod)}>{t("modlist.rename")}</button>
                  <button onClick={() => { onReinstall(mod); onSetOpenMenuKey(null); }}>{t("modlist.reinstall")}</button>
                  <button className="danger" onClick={() => { onUninstall(mod); onSetOpenMenuKey(null); }}>{t("bulk.remove")}</button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}