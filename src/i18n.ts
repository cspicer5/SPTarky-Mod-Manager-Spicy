/**
 * This fork is English-only. The type is kept as a one-member union rather than deleted
 * so the translate()/t() call sites and the backend-message layer keep their shape —
 * removing the parameter would touch hundreds of call sites for no behavioural gain.
 */
export type Lang = "en";

type Dict = Record<string, string>;

/**
 * Static UI strings (buttons, labels, headers, tooltips, placeholders).
 * Dot-notation keys grouped by section, to keep them findable.
 * Use {var} inside a string to interpolate via t(key, { var: value }).
 */
const en: Dict = {
  "toast.instanceConfigured": "Instance configured.",
  "toast.folderSelectFailed": "Couldn't select the folder.",
  "toast.dropInvalidFile": "Drop a .zip, .7z, or .rar file to install.",
  "toast.confirmRemove": 'Permanently remove "{name}"?',
  "toast.selectUpdatedFile": "Select the mod's updated file (.zip / .7z / .rar)...",
  "toast.noConflictsFound": "No obvious conflicts found.",
  "toast.conflictsFound": "{count} possible conflict(s) found.",
  "toast.enterSptVersion": "Enter the SPT version before checking.",
  "toast.forgeUpdateCheckFailed": "Failed to check for updates.",
  "toast.forgeAllUpToDate": "Everything up to date (or not found on Forge).",
  "toast.forgeUpdatesAvailable": "{count} update(s) available.",
  "toast.forgeSearchFailed": "Failed to search mods on Forge.",
  "toast.confirmRemoveBulk": "Permanently remove {count} mod(s)?",
  "toast.bulkProcessed": "{done}/{total} mod(s) processed.",

  "empty.selectFolder": "Select your SPT instance folder to get started.",
  "empty.selectFolderButton": "Select instance folder",
  "empty.downloadModsButton": "Download mods (hub.sp-tarkov.com)",
  "dropOverlay.text": "Drop the .zip / .7z / .rar file(s) here to install",

  "header.browseForge": "Browse mods (Forge)",
  "header.browseForgeTitle": "Search and install mods straight from Forge's catalogue",
  "header.openHub": "Download mods",
  "header.openHubTitle": "Open hub.sp-tarkov.com in the browser",
  "header.changeInstance": "Change instance",
  "header.changeInstanceTitle": "Select a different SPT instance",
  "header.installButton": "Install mod (.zip / .7z / .rar)",
  "header.installButtonTitle": "Choose a .zip, .7z, or .rar to install",
  "header.installing": "Installing...",
  "header.splitInstance": "Client: {client}  •  Server: {server}",

  "summary.total": "mod(s) installed",
  "summary.active": "Active:",
  "summary.disabled": "Disabled:",
  "summary.versionTooltip":
    "Read from SPT_Data/Server/configs/core.json — starting with SPT 4.0 this file only stores the compatible Tarkov version, not the SPT version itself",
  "summary.validInstance": "Valid instance",
  "summary.validInstanceTitle": "The selected folder passed SPT instance validation",

  "filters.searchPlaceholder": "Search mod by name...",
  "filters.typeFilterTitle": "Filter by type",
  "filters.typeAll": "All types",
  "filters.statusFilterTitle": "Filter by status",
  "filters.statusAll": "Active and disabled",
  "filters.statusEnabled": "Active only",
  "filters.statusDisabled": "Disabled only",
  "filters.originFilterTitle": "Filter by origin",
  "filters.originAll": "Any origin",
  "filters.originManual": "Installed manually",
  "filters.originManager": "Installed by the Manager",
  "filters.sortFieldTitle": "Sort by",
  "filters.sortByName": "Sort by Name",
  "filters.sortByStatus": "Sort by Status",
  "filters.sortByOrigin": "Sort by Origin",
  "filters.sortByInstalledAt": "Sort by Install date",
  "filters.sortByForge": "Sort by Forge status",
  "filters.sortDirectionTitle": "Reverse sort direction",
  "filters.sortAsc": "↑ Ascending",
  "filters.sortDesc": "↓ Descending",
  "filters.sortAZ": "↑ A-Z",
  "filters.sortZA": "↓ Z-A",
  "filters.sortOldestFirst": "↑ Oldest first",
  "filters.sortNewestFirst": "↓ Newest first",
  "filters.selectAllVisible": "Select all (visible)",
  "filters.selectAllVisibleTitle": "Select every mod visible with the current filters",
  "filters.clearSelection": "Clear selection",
  "filters.exportList": "Export list",
  "filters.exportListTitle": "Save the current mod list to a JSON file",
  "filters.importCompare": "Import / Compare",
  "filters.importCompareTitle": "Compare the current instance against a previously exported list",
  "filters.checkConflicts": "Check conflicts",
  "filters.checkingConflicts": "Checking...",
  "filters.checkConflictsTitle":
    "Looks for duplicate DLLs between client mods and duplicate names between server mods",
  "filters.sptVersionTitle": "SPT version used when checking for Forge updates — the list comes straight from Forge",
  "filters.sptVersionPlaceholder": "select the SPT version...",
  "filters.sptVersionNotListed": "(not listed on Forge)",
  "filters.forgeCheckTitle": "Queries Forge's public API (forge.sp-tarkov.com) for updates to installed mods",
  "filters.forgeChecking": "Checking Forge...",
  "filters.forgeCheckingProgress": "Checking Forge... ({done}/{total})",
  "filters.forgeCheckButton": "Check for updates (Forge)",

  "hint.forgeLastChecked": "Last checked on Forge: {date}",

  "compare.title": "Comparison with imported list",
  "compare.identical": "Both lists are identical.",
  "compare.missing": "Missing here ({count}):",
  "compare.extra": "Extra here, not in the imported list ({count}):",
  "compare.note":
    "Anything missing here comes with an offer to download it automatically from Forge (matched by name) — whatever it can't find that way still needs a manual install, since the app doesn't keep the mods' original files.",

  "conflicts.title": "Conflict check",
  "conflicts.appearsIn": "appears in:",
  "conflicts.nameLabel": "Name",
  "conflicts.sameModTwice": "The same mod is installed in two folders:",
  "conflicts.declaredInMultiple": "declared in more than one folder:",
  "conflicts.note": "File-level check — it flags overlap, it doesn't guarantee an actual incompatibility.",

  "forge.checkTitle": "Update check (Forge)",
  "forge.updatesAvailable": "Updates available:",
  "forge.updateNow": "Update",
  "forge.updating": "Updating...",
  "forge.blockedTitle": "Blocked updates (would break a dependency):",
  "forge.incompatibleTitle": "Incompatible with this SPT version:",
  "forge.infoOnlyTitle": "No local version to compare (showing what Forge has):",
  "forge.infoHasVersion": "Forge has v{version}",
  "forge.allUpToDateDetailed": "Every mod identified on Forge is up to date.",
  "forge.unmatchedPrefix": "Not found on Forge (matched by name):",
  "forge.skippedByBudget": "{count} mod(s) weren't checked: Forge's request limit was reached. Run the check again to finish — whatever was already resolved is cached and won't be looked up again.",
  "forge.matchNote":
    "Matching against Forge's catalogue is done by name — it may not find mods with a very generic name, or ones not listed there.",

  "bulk.selectedCount": "{count} selected",
  "bulk.enable": "Enable",
  "bulk.disable": "Disable",
  "bulk.remove": "Remove",
  "bulk.cancelSelection": "Cancel selection",

  "noResults.text": "No mod matches the current filters/search.",
  "noResults.clearFilters": "Clear filters",

  "common.close": "Close",

  "browse.title": "Search Forge mods",
  "browse.searchPlaceholder": "Search by name, slug, or description...",
  "browse.categoryFilterTitle": "Filter by category",
  "browse.allCategories": "All categories",
  "browse.compatibleOnlyTitle": "Uses the SPT version selected in the main filters",
  "browse.compatibleOnlyLabel": "Only compatible with {version}",
  "browse.selectVersionPlaceholder": "(select the SPT version)",
  "browse.searching": "Searching...",
  "browse.searchButton": "Search",
  "browse.noResults": "No mods found with these filters.",
  "browse.viewOnForgeTitle": "View on Forge (opens in browser)",
  "browse.fikaCompatibleTitle": "Has a Fika-compatible version",
  "browse.byAuthor": "by {author}",
  "browse.downloadsLabel": "downloads",
  "browse.chooseVersionTitle": "Choose the version to install",
  "browse.installing": "Installing...",
  "browse.installButton": "Install",
  "browse.noVersionPublished": '"{name}" has no published version to install.',
  "browse.noVersionPublishedShort": "No version published",
  "browse.prevPage": "← Previous",
  "browse.pageOf": "Page {page} of {lastPage}",
  "browse.nextPage": "Next →",
  "browse.installNote":
    'Installing downloads the file straight from Forge and runs it through the same installer as the "Install mod" button — including client/server mod detection and registering it with the Manager.',

  "confirm.title": "Unusual file structure",
  "confirm.descriptionPrefix": "I couldn't find any DLL,",
  "confirm.descriptionMid": "or a",
  "confirm.descriptionSuffix":
    "folder in this file. This could be a mod packaged in an unusual way, or the wrong file. Here's what's in the root of the file:",
  "confirm.emptyArchive": "(empty archive)",
  "confirm.explanation":
    'If you recognize this as a valid mod, "Continue anyway" copies everything listed above straight into your SPT instance root (the same way auto-detected mods are installed), and registers it as an item you can remove later. If you don\'t recognize it, aborting is safer.',
  "confirm.abort": "Abort",
  "confirm.proceed": "Continue anyway",

  "modlist.emptyCategory": "No mods in this category.",
  "modlist.checkboxTitle": "Click to select, Shift+Click to select a range",
  "modlist.renameTitle": "{name} (double-click to rename)",
  "modlist.statusActive": "Active",
  "modlist.statusDisabled": "Disabled",
  "modlist.forgeUpdateAvailableTitle": "New version available on Forge",
  "modlist.forgeUpdateAvailable": "Forge: v{version} available",
  "modlist.forgeBlockedTitle": "Has an update on Forge, but installing it would break another mod's dependency",
  "modlist.forgeBlocked": "Forge: update blocked",
  "modlist.forgeIncompatibleTitle":
    "The installed version isn't compatible with the SPT version entered in the last check",
  "modlist.forgeIncompatible": "Forge: incompatible",
  "modlist.forgeInfoTitle":
    "No readable local version to compare (mod without package.json, e.g. .dll-only mods) — this is the latest version known on Forge",
  "modlist.forgeInfo": "Forge: v{version}",
  "modlist.orphanTitle": "Loose files tracked by manifest (no folder of its own) — can only be removed",
  "modlist.orphan": "Orphan",
  "modlist.sptIncompatible": "SPT mismatch",
  "modlist.sptIncompatibleTitle": "The mod itself declares support for SPT {declared}, which doesn't match your selected version. Read from the mod's DLL, no internet needed.",
  "modlist.packagePart": "{count}-part package",
  "modlist.packageTooltip": "This mod comes in parts that work together. Enabling or disabling one switches them all. Other parts: {others}",
  "modlist.packageTooltipInferred": "Detected automatically as parts of the same mod (same folder name on both sides). Enabling or disabling one switches them all. Other parts: {others}",
  "modlist.actionsTitle": "Actions",
  "modlist.openFolder": "Open folder",
  "modlist.rename": "Rename",
  "modlist.reinstall": "Reinstall",

  "queue.waiting": "Waiting...",
  "queue.installing": "Installing...",
  "queue.done": "Done",
  "queue.failed": "Failed",
  "queue.noFilePath": "File path not available.",

  "restore.confirmDownload": "Found {count} missing mod(s) from the imported list. Download them automatically from Forge?",
  "restore.allInstalled": "{count} mod(s) installed successfully.",
  "restore.partialInstalled": "{installed} installed; not found or failed on Forge: {notFound}",
  "restore.confirmDisable": "{count} installed mod(s) aren't in the imported list. Disable those mods?",
  "restore.disabledCount": "{count} mod(s) disabled.",
  "restore.lookingUp": "Looking the mods up on Forge...",
  "restore.lookingUpCount": "Looking up on Forge... ({done}/{total})",
  "restore.installingProgress": "Installing mods... ({done}/{total})",
  "restore.andMore": " and {count} more",

  "update.available": "New Mod Manager version available: v{latest} (you're on v{current}).",
  "update.download": "Download on Forge",
  "update.viewChangelog": "Changelog",
  "update.dismiss": "Not now"
};

export const DICTIONARIES: Record<Lang, Dict> = { en };

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  // Falls back to the raw key when a string is missing. That is deliberate: a missing
  // key shows up as visible gibberish rather than a silently blank label.
  let str = DICTIONARIES[lang][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

/**
 * O backend (processo main / modManager.ts) sempre responde em português —
 * ele não sabe em qual idioma a UI está. Em vez de reescrever todas as ~50
 * mensagens do backend pra retornar códigos (grande refatoração, mais risco
 * de reintroduzir bug nas partes que acabamos de corrigir), a gente traduz
 * aqui na hora de exibir, casando contra o conjunto conhecido de mensagens.
 * Se uma mensagem nova não bater com nenhuma regra, mostra o texto original
 * (em português) em vez de quebrar — é um degrade aceitável.
 */
interface BackendMessageRule {
  pattern: RegExp;
  en: (m: RegExpMatchArray, lang: Lang) => string;
}

const BACKEND_MESSAGE_RULES: BackendMessageRule[] = [
  // --- Mensagens fixas (sem parte dinâmica) ---
  { pattern: /^Nenhuma instância SPT configurada\.$/, en: () => "No SPT instance configured." },
  { pattern: /^Cancelado\.$/, en: () => "Cancelled." },
  { pattern: /^Pasta aberta\.$/, en: () => "Folder opened." },
  { pattern: /^Nome restaurado pro original\.$/, en: () => "Name restored to original." },
  { pattern: /^Nome atualizado\.$/, en: () => "Name updated." },
  {
    pattern: /^Estrutura de arquivo incomum: não encontrei DLL, package\.json nem pasta user\/BepInEx\.$/,
    en: () => "Unusual file structure: found no DLL, package.json, or user/BepInEx folder."
  },
  { pattern: /^Mod instalado e verificado \(estrutura completa detectada\)\.$/, en: () => "Mod installed and verified (full structure detected)." },
  { pattern: /^Caminho temporário inválido\.$/, en: () => "Invalid temporary path." },
  {
    pattern: /^A extração temporária não existe mais — tente instalar o arquivo de novo\.$/,
    en: () => "The temporary extraction no longer exists — try installing the file again."
  },
  { pattern: /^Instalação cancelada\.$/, en: () => "Installation cancelled." },
  {
    pattern: /^Esse item é um arquivo do próprio SPT \(não é um mod\) e não pode ser alternado\.$/,
    en: () => "This item is one of SPT's own files (not a mod) and can't be toggled."
  },
  {
    pattern: /^Esse item é um arquivo do próprio SPT \(não é um mod\) e não pode ser removido pelo Manager\.$/,
    en: () => "This item is one of SPT's own files (not a mod) and can't be removed by the Manager."
  },
  { pattern: /^Mod desabilitado\.$/, en: () => "Mod disabled." },
  {
    pattern: /^Mod desabilitado \((\d+) partes do pacote\)\.$/,
    en: (m) => `Mod disabled (${m[1]} package parts).`
  },
  {
    pattern: /^Mod habilitado \((\d+) partes do pacote\)\.$/,
    en: (m) => `Mod enabled (${m[1]} package parts).`
  },
  {
    pattern: /^Mod desabilitado \(e (\d+) patcher\(s\) junto\)\.$/,
    en: (m) => `Mod disabled (along with ${m[1]} patcher(s)).`
  },
  {
    pattern: /^Mod habilitado \(e (\d+) patcher\(s\) junto\)\.$/,
    en: (m) => `Mod enabled (along with ${m[1]} patcher(s)).`
  },
  { pattern: /^Mod habilitado\.$/, en: () => "Mod enabled." },
  { pattern: /^Entrada removida da lista \(nenhum arquivo rastreado\)\.$/, en: () => "Entry removed from the list (no tracked files)." },
  { pattern: /^Mod removido\.$/, en: () => "Mod removed." },
  {
    pattern: /^Mod instalado\. (\d+) arquivo\(s\) do núcleo do SPT vieram no pacote e foram ignorados, pra não quebrar a instalação\.$/,
    en: (m) => `Mod installed. ${m[1]} SPT core file(s) shipped inside the package were skipped, to avoid breaking the installation.`
  },
  {
    pattern: /^Mod removido \(e (\d+) arquivo\(s\) que vieram junto\)\.$/,
    en: (m) => `Mod removed (along with ${m[1]} file(s) that came with it).`
  },
  { pattern: /^Pasta de server mods não existe\.$/, en: () => "Server mods folder doesn't exist." },
  { pattern: /^Ordem de carregamento atualizada\.$/, en: () => "Load order updated." },
  { pattern: /^Falha ao verificar atualizações\.$/, en: () => "Failed to check for updates." },
  { pattern: /^Falha ao buscar mods na Forge\.$/, en: () => "Failed to search mods on Forge." },
  {
    pattern: /^Esse arquivo não parece uma lista de mods exportada por este app\.$/,
    en: () => "This file doesn't look like a mod list exported by this app."
  },
  {
    pattern: /^Não achei uma instância SPT nessa pasta nem nas subpastas diretas dela\. Selecione a pasta que tem o SPT\.Server\.exe\.$/,
    en: () => "Couldn't find an SPT instance in that folder or its direct subfolders. Select the folder that has SPT.Server.exe."
  },
  { pattern: /^Informe a versão do SPT antes de verificar atualizações\.$/, en: () => "Enter the SPT version before checking for updates." },

  // --- Mensagens com parte dinâmica (nome de arquivo, contagem, erro etc.) ---
  {
    pattern: /^Instalação incompleta: arquivo não confirmado no destino \((.+)\)\.$/,
    en: (m) => `Incomplete installation: file not confirmed at destination (${m[1]}).`
  },
  {
    pattern: /^Mod "(.+)" instalado e verificado como (server mod|client mod)\.$/,
    en: (m) => `Mod "${m[1]}" installed and verified as a ${m[2] === "server mod" ? "server mod" : "client mod"}.`
  },
  { pattern: /^Erro ao instalar: (.+)$/, en: (m, lang) => `Error installing: ${translateBackendMessage(m[1], lang)}` },
  { pattern: /^(\d+) arquivo\(s\) órfão\(s\) removido\(s\)\.$/, en: (m) => `${m[1]} orphan file(s) removed.` },
  { pattern: /^Arquivo\/pasta do mod não encontrado: (.+)$/, en: (m) => `Mod file/folder not found: ${m[1]}` },
  { pattern: /^Mod não encontrado: (.+)$/, en: (m) => `Mod not found: ${m[1]}` },
  { pattern: /^Não foi possível baixar o mod da Forge \(HTTP (\d+)\)\.$/, en: (m) => `Couldn't download the mod from Forge (HTTP ${m[1]}).` },
  { pattern: /^Falha ao baixar\/instalar da Forge: (.+)$/, en: (m) => `Failed to download/install from Forge: ${m[1]}` },
  { pattern: /^Instância encontrada automaticamente em: (.+)$/, en: (m) => `Instance automatically found at: ${m[1]}` },
  {
    pattern: /^Instância dividida detectada — client em "(.+)", server em "(.+)"\.$/,
    en: (m) => `Split instance detected — client at "${m[1]}", server at "${m[2]}".`
  },
  { pattern: /^Arquivo "(.+)" não é \.zip, \.7z nem \.rar\.$/, en: (m) => `File "${m[1]}" isn't .zip, .7z, or .rar.` },
  { pattern: /^Caminho do mod não encontrado: (.+)$/, en: (m) => `Mod path not found: ${m[1]}` },
  { pattern: /^Lista exportada com (\d+) mod\(s\) para (.+)\.$/, en: (m) => `List exported with ${m[1]} mod(s) to ${m[2]}.` },
  { pattern: /^Comparado com (\d+) mod\(s\) da lista importada\.$/, en: (m) => `Compared against ${m[1]} mod(s) from the imported list.` },
  { pattern: /^Erro ao ler o arquivo: (.+)$/, en: (m) => `Error reading the file: ${m[1]}` },
  { pattern: /^Não foi possível consultar o Forge: (.+)$/, en: (m) => `Couldn't reach Forge: ${m[1]}` },
  { pattern: /^Forge respondeu (\d+)$/, en: (m) => `Forge responded ${m[1]}` },
  {
    pattern: /^Arquivo rejeitado por segurança: entrada suspeita no \.(7z|rar|zip) \("(.+)"\)\.$/,
    en: (m) => `File rejected for security reasons: suspicious entry in the .${m[1]} ("${m[2]}").`
  }
];

export function translateBackendMessage(msg: string | undefined | null, lang: Lang): string {
  if (!msg) return msg ?? "";
  for (const rule of BACKEND_MESSAGE_RULES) {
    const match = msg.match(rule.pattern);
    if (match) return rule.en(match, lang);
  }
  // No rule matched. The backend still speaks Portuguese, so this falls through as the
  // original string — ugly, but showing the raw message beats swallowing it. Any such
  // string appearing in the UI is a missing rule, not a broken build.
  return msg;
}
