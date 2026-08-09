using System.Text.Json.Serialization;
using SPTarkov.Server.Core.Models.Spt.Mod;

namespace SptarkyCompanion;

/// <summary>
/// Everything the manager cannot learn from a stock SPT server, gathered in one answer.
///
/// <para>
/// The guiding decision: this reports FACTS and does no reconciling. Matching a folder to a
/// catalogue entry, deciding which version to believe, walking the provenance ladder — all of
/// that already exists in the manager, is well tested, and would be a second implementation to
/// keep in step if it were duplicated here in C#. So the ledgers go back verbatim, as the exact
/// text on disk, and the manager reads them with the same code it uses for a local install.
/// </para>
/// <para>
/// No absolute paths are returned. The manager has no use for the server's disk layout, and
/// this is a network surface — <c>ServerRootFound</c>/<c>ClientRootFound</c> carry everything
/// needed to diagnose "the companion cannot see your game folder" without publishing where it
/// lives.
/// </para>
/// </summary>
public class ManifestResponse
{
    [JsonPropertyName("protocol")]
    public int Protocol { get; set; }

    [JsonPropertyName("companionVersion")]
    public string CompanionVersion { get; set; } = "";

    /// <summary>False when the server half could not be located — every list below is then empty because it is UNKNOWN, not because it is empty.</summary>
    [JsonPropertyName("serverRootFound")]
    public bool ServerRootFound { get; set; }

    /// <summary>False on a server with no game files beside it. Client mods cannot be reported at all in that case.</summary>
    [JsonPropertyName("clientRootFound")]
    public bool ClientRootFound { get; set; }

    [JsonPropertyName("split")]
    public bool Split { get; set; }

    [JsonPropertyName("serverMods")]
    public List<ServerModEntry> ServerMods { get; set; } = [];

    [JsonPropertyName("clientMods")]
    public List<ClientModEntry> ClientMods { get; set; } = [];

    /// <summary>The manager's own registry file, verbatim, or null if this install has never been managed by it.</summary>
    [JsonPropertyName("registryJson")]
    public string? RegistryJson { get; set; }

    /// <summary>The addon ledger, verbatim, or null.</summary>
    [JsonPropertyName("addonsJson")]
    public string? AddonsJson { get; set; }

    /// <summary>Anything that went wrong while gathering, in words. A partial manifest is more useful than an error.</summary>
    [JsonPropertyName("warnings")]
    public List<string> Warnings { get; set; } = [];
}

public class ServerModEntry
{
    /// <summary>The folder name under user/mods — the manager's identity for a mod.</summary>
    [JsonPropertyName("folder")]
    public string Folder { get; set; } = "";

    [JsonPropertyName("guid")]
    public string? Guid { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("author")]
    public string? Author { get; set; }

    /// <summary>What the mod DECLARES. Frequently wrong; the ledger is the better source and is why it is also sent.</summary>
    [JsonPropertyName("declaredVersion")]
    public string? DeclaredVersion { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("isBundleMod")]
    public bool? IsBundleMod { get; set; }

    /// <summary>Present in user/mods but absent from the loaded list — it failed validation or threw on load.</summary>
    [JsonPropertyName("loaded")]
    public bool Loaded { get; set; }

    /// <summary>False for anything sitting in user/mods.disabled.</summary>
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;
}

public class ClientModEntry
{
    /// <summary>Folder or file name as it appears under BepInEx.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    /// <summary>"folder" or "file" — a client mod is commonly a loose Mod.dll plus a Mod/ folder beside it.</summary>
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = "";

    /// <summary>"plugins" or "patchers". Prepatchers load before the game and live outside plugins/.</summary>
    [JsonPropertyName("area")]
    public string Area { get; set; } = "";

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("sizeBytes")]
    public long SizeBytes { get; set; }
}

/// <summary>
/// Reads the install and produces the manifest. Every step is individually guarded: a server
/// with no BepInEx, no ledger, or an unreadable folder still returns a usable answer with the
/// gap named in <see cref="ManifestResponse.Warnings"/>, because silently returning an empty
/// list would read as "this server has no mods" — a claim that would have someone delete mods
/// they still need.
/// </summary>
public static class ManifestBuilder
{
    private const string RegistryFile = ".spt-mod-manager-registry.json";
    private const string AddonsFile = ".spt-mod-manager-addons.json";

    public static ManifestResponse Build(InstallLayout layout, IReadOnlyList<SptMod> loadedMods, int protocol, string companionVersion)
    {
        var manifest = new ManifestResponse
        {
            Protocol = protocol,
            CompanionVersion = companionVersion,
            ServerRootFound = layout.ServerRoot != null,
            ClientRootFound = layout.ClientRoot != null,
            Split = layout.Split
        };

        AddServerMods(manifest, layout, loadedMods);
        AddClientMods(manifest, layout);
        AddLedgers(manifest, layout);
        return manifest;
    }

    private static void AddServerMods(ManifestResponse manifest, InstallLayout layout, IReadOnlyList<SptMod> loadedMods)
    {
        // SPT's own loaded list is the exact truth for anything that started: identity straight
        // from the metadata the server itself read, with no second parse to disagree with it.
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (SptMod mod in loadedMods)
        {
            string folder = SafeFolderName(mod.Directory);
            seen.Add(folder);
            manifest.ServerMods.Add(new ServerModEntry
            {
                Folder = folder,
                Guid = mod.ModMetadata?.ModGuid,
                Name = mod.ModMetadata?.Name,
                Author = mod.ModMetadata?.Author,
                DeclaredVersion = mod.ModMetadata?.Version?.ToString(),
                Url = mod.ModMetadata?.Url,
                IsBundleMod = mod.ModMetadata?.IsBundleMod,
                Loaded = true,
                Enabled = true
            });
        }

        if (layout.ServerRoot == null)
        {
            manifest.Warnings.Add("The server's mod folder could not be located, so only mods already loaded are listed.");
            return;
        }

        // A folder present but missing from the loaded list did not start — it failed validation
        // or threw. Reporting it as absent would be a lie in the direction that gets a working
        // mod reinstalled over the top of a broken one.
        ScanModFolders(manifest, Path.Combine(layout.ServerRoot, "user", "mods"), enabled: true, seen);
        ScanModFolders(manifest, Path.Combine(layout.ServerRoot, "user", "mods.disabled"), enabled: false, seen);
    }

    private static void ScanModFolders(ManifestResponse manifest, string dir, bool enabled, HashSet<string> seen)
    {
        if (!Directory.Exists(dir)) return;
        try
        {
            foreach (string folder in Directory.EnumerateDirectories(dir))
            {
                string name = Path.GetFileName(folder);
                if (!seen.Add(name)) continue;
                manifest.ServerMods.Add(new ServerModEntry { Folder = name, Loaded = false, Enabled = enabled });
            }
        }
        catch (Exception ex)
        {
            manifest.Warnings.Add($"Could not read {Path.GetFileName(dir)}: {ex.Message}");
        }
    }

    private static void AddClientMods(ManifestResponse manifest, InstallLayout layout)
    {
        if (layout.ClientRoot == null)
        {
            // Said explicitly. "No client mods" and "the client half is not here" must never
            // reduce to the same empty list.
            manifest.Warnings.Add("No BepInEx folder was found beside the server, so client mods cannot be read from this machine.");
            return;
        }

        string bep = Path.Combine(layout.ClientRoot, "BepInEx");
        foreach ((string sub, string area, bool enabled) in new[]
        {
            ("plugins", "plugins", true),
            ("plugins.disabled", "plugins", false),
            ("patchers", "patchers", true),
            ("patchers.disabled", "patchers", false),
        })
        {
            string dir = Path.Combine(bep, sub);
            if (!Directory.Exists(dir)) continue;
            try
            {
                foreach (string entry in Directory.EnumerateFileSystemEntries(dir))
                {
                    bool isDir = Directory.Exists(entry);
                    // Only DLLs matter among loose files; configs and readmes are noise here.
                    if (!isDir && !string.Equals(Path.GetExtension(entry), ".dll", StringComparison.OrdinalIgnoreCase)) continue;
                    manifest.ClientMods.Add(new ClientModEntry
                    {
                        Name = Path.GetFileName(entry),
                        Kind = isDir ? "folder" : "file",
                        Area = area,
                        Enabled = enabled,
                        SizeBytes = isDir ? 0 : SafeLength(entry)
                    });
                }
            }
            catch (Exception ex)
            {
                manifest.Warnings.Add($"Could not read BepInEx/{sub}: {ex.Message}");
            }
        }
    }

    private static void AddLedgers(ManifestResponse manifest, InstallLayout layout)
    {
        // Both ledgers live at the CLIENT root even for server mods — the manager keeps one
        // registry per instance, not one per half.
        string? root = layout.ClientRoot ?? layout.ServerRoot;
        if (root == null) return;

        manifest.RegistryJson = ReadIfPresent(manifest, Path.Combine(root, RegistryFile));
        manifest.AddonsJson = ReadIfPresent(manifest, Path.Combine(root, AddonsFile));

        if (manifest.RegistryJson == null)
        {
            manifest.Warnings.Add("This install has no SPTarky registry, so only versions the mods declare about themselves are available.");
        }
    }

    private static string? ReadIfPresent(ManifestResponse manifest, string file)
    {
        if (!File.Exists(file)) return null;
        try
        {
            return File.ReadAllText(file);
        }
        catch (Exception ex)
        {
            manifest.Warnings.Add($"Could not read {Path.GetFileName(file)}: {ex.Message}");
            return null;
        }
    }

    /// <summary>SptMod.Directory arrives relative, as "./user/mods/Name". Only the leaf identifies the mod.</summary>
    private static string SafeFolderName(string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory)) return "";
        return Path.GetFileName(directory.TrimEnd('/', '\\')) ?? "";
    }

    private static long SafeLength(string file)
    {
        try { return new FileInfo(file).Length; }
        catch { return 0; }
    }
}
