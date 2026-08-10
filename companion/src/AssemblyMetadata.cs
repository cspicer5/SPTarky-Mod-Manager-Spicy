using System.Collections.Concurrent;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace SptarkyCompanion;

/// <summary>
/// Reads a client plugin's declared identity straight out of its DLL.
///
/// <para>
/// This exists because of a gap found by comparing two real machines. The manager knows a
/// client plugin's version because it reads <c>[BepInPlugin(guid, name, version)]</c> out of the
/// assembly itself; the companion, until now, only shipped the version LEDGER and a directory
/// listing. So any plugin installed by hand — dropped into BepInEx/plugins without the manager
/// — had no version on the server side and was permanently "cannot be compared", no matter how
/// many times the ledger was rebuilt. Measured on the reference pair: quicksell read 2.3.0
/// locally and nothing at all remotely, and the two machines had identical files.
/// </para>
/// <para>
/// The attribute is read, never executed. <see cref="MetadataReader"/> walks the CLI metadata
/// tables on disk; the assembly is not loaded, no code in it runs, and nothing it references has
/// to resolve. That matters more here than in the manager: this runs inside the live game server
/// process, where loading a plugin built against the Unity client would at best fail and at worst
/// pull a second copy of a shared type into the process.
/// </para>
/// <para>
/// This mirrors <c>electron/peMetadata.ts</c> on the manager side deliberately — same attribute,
/// same argument order, same preference of a declared version over the assembly's own. Two
/// implementations of one rule is a cost; two DIFFERENT rules either side of a comparison would
/// be a source of false differences, which is worse.
/// </para>
/// </summary>
public static class AssemblyMetadata
{
    public sealed class Info
    {
        /// <summary>The GUID from <c>[BepInPlugin]</c>. The only identifier that survives a folder rename.</summary>
        public string? Guid { get; init; }

        /// <summary>The human name the author gave it, which is rarely the file name.</summary>
        public string? Name { get; init; }

        /// <summary>The version from <c>[BepInPlugin]</c> — what the author published.</summary>
        public string? Version { get; init; }

        /// <summary>
        /// The assembly's own version, from AssemblyInformationalVersion or AssemblyFileVersion.
        /// Kept SEPARATE from <see cref="Version"/> on purpose: the version compiled into an
        /// assembly is not always the version that was published, so it is a last resort the
        /// caller opts into rather than a substitute the reader applies silently.
        /// </summary>
        public string? AssemblyVersion { get; init; }

        public bool IsEmpty => Guid == null && Name == null && Version == null && AssemblyVersion == null;
    }

    private static readonly Info Empty = new();

    /// <summary>
    /// Cached by path plus write time plus length.
    ///
    /// The manifest route is read on every refresh and a client install is commonly 40+ plugins,
    /// several of which are folders that have to be walked. Caching on the file's own stamp means
    /// a plugin that is replaced on disk is re-read on the next request rather than reported from
    /// a stale entry — which is the same reason the manifest itself is built per request instead
    /// of at startup.
    /// </summary>
    private static readonly ConcurrentDictionary<string, (long Ticks, long Length, Info Info)> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>How deep to look inside a plugin FOLDER, and how many files to open, before giving up.</summary>
    private const int MaxFolderDepth = 4;
    private const int MaxFilesPerFolder = 64;

    /// <summary>
    /// Identity for a plugin that ships as a folder.
    ///
    /// The first DLL that declares a GUID or a version wins, which is what the manager does for
    /// the same case. Bounded in both depth and file count because this answers a network request:
    /// a plugin folder that happens to contain a vendored dependency tree must not turn one
    /// manifest read into thousands of file opens.
    /// </summary>
    public static Info ReadFolder(string folder)
    {
        Info best = Empty;
        int opened = 0;

        foreach (string dll in EnumerateDlls(folder, MaxFolderDepth))
        {
            if (opened++ >= MaxFilesPerFolder) break;
            Info info = ReadFile(dll);
            if (info.Guid != null || info.Version != null) return info;
            // No declared identity, but it may still carry an assembly version. Held rather than
            // returned, so a later DLL that declares itself properly still wins.
            if (best.IsEmpty && !info.IsEmpty) best = info;
        }

        return best;
    }

    /// <summary>
    /// Identity for a single assembly. Returns an empty <see cref="Info"/> for anything that is
    /// not a managed assembly, or that declares nothing — never throws, because one unreadable
    /// plugin must not cost the caller the whole manifest.
    /// </summary>
    public static Info ReadFile(string file)
    {
        try
        {
            var stamp = new FileInfo(file);
            if (!stamp.Exists) return Empty;

            string key = stamp.FullName;
            if (Cache.TryGetValue(key, out var cached) && cached.Ticks == stamp.LastWriteTimeUtc.Ticks && cached.Length == stamp.Length)
            {
                return cached.Info;
            }

            Info info = Read(file);
            Cache[key] = (stamp.LastWriteTimeUtc.Ticks, stamp.Length, info);
            return info;
        }
        catch
        {
            // Locked, deleted mid-read, or malformed. All ordinary on a live install.
            return Empty;
        }
    }

    private static Info Read(string file)
    {
        // FileShare.ReadWrite | Delete, because the game or another tool may legitimately hold
        // these files. Reading metadata must never be the thing that blocks a mod being replaced.
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        // PrefetchMetadata pulls just the metadata into memory, so the handle is released as soon
        // as this returns rather than being held for the lifetime of the reader.
        using var pe = new PEReader(stream, PEStreamOptions.PrefetchMetadata);
        if (!pe.HasMetadata) return Empty; // a native DLL — BepInEx folders contain those too

        MetadataReader md = pe.GetMetadataReader();

        (string? guid, string? name, string? version) = ReadBepInPlugin(md);
        string? assemblyVersion = ReadAssemblyVersion(md);

        if (guid == null && name == null && version == null && assemblyVersion == null) return Empty;
        return new Info { Guid = guid, Name = name, Version = version, AssemblyVersion = assemblyVersion };
    }

    /// <summary>
    /// <c>[BepInPlugin(GUID, Name, Version)]</c> on the plugin class.
    ///
    /// Matched by the attribute type's NAME, resolved through the constructor's declaring type.
    /// That is what tells it apart from <c>[BepInDependency("some.other.guid")]</c>, which sits
    /// beside it and looks identical to anything scanning for plausible strings — the mistake
    /// that once had a mod reported under its dependency's identity.
    /// </summary>
    private static (string? Guid, string? Name, string? Version) ReadBepInPlugin(MetadataReader md)
    {
        foreach (CustomAttributeHandle handle in md.CustomAttributes)
        {
            try
            {
                CustomAttribute attribute = md.GetCustomAttribute(handle);
                if (AttributeTypeName(md, attribute) != "BepInPlugin") continue;

                BlobReader blob = md.GetBlobReader(attribute.Value);
                if (blob.Length < 2 || blob.ReadUInt16() != 1) continue; // prolog is always 0x0001

                // Fixed arguments, in declared order. ReadSerializedString handles both the
                // compressed length prefix and the 0xFF that means an explicit null.
                string? guid = blob.ReadSerializedString();
                string? name = blob.RemainingBytes > 0 ? blob.ReadSerializedString() : null;
                string? version = blob.RemainingBytes > 0 ? blob.ReadSerializedString() : null;

                if (string.IsNullOrWhiteSpace(guid)) continue;
                return (guid, Blank(name), Blank(version));
            }
            catch
            {
                // A single malformed attribute is not a reason to abandon the rest.
            }
        }
        return (null, null, null);
    }

    /// <summary>
    /// Prefers AssemblyInformationalVersion: it carries the real semver including a pre-release
    /// tag ("1.0.0-pre1"), which AssemblyFileVersion cannot represent at all — it is four numbers,
    /// so "1.0.0-pre1" would flatten to "1.0.0" and compare EQUAL to the release.
    /// </summary>
    private static string? ReadAssemblyVersion(MetadataReader md)
    {
        if (!md.IsAssembly) return null;

        string? informational = null;
        string? file = null;

        foreach (CustomAttributeHandle handle in md.GetAssemblyDefinition().GetCustomAttributes())
        {
            try
            {
                CustomAttribute attribute = md.GetCustomAttribute(handle);
                string? typeName = AttributeTypeName(md, attribute);
                if (typeName != "AssemblyInformationalVersionAttribute" && typeName != "AssemblyFileVersionAttribute") continue;

                BlobReader blob = md.GetBlobReader(attribute.Value);
                if (blob.Length < 2 || blob.ReadUInt16() != 1) continue;
                string? value = blob.ReadSerializedString();
                if (string.IsNullOrWhiteSpace(value)) continue;

                if (typeName == "AssemblyInformationalVersionAttribute") informational = value;
                else file = value;
            }
            catch
            {
            }
        }

        string? raw = informational ?? file;
        if (raw == null) return null;

        // "+buildmetadata" is ignored by semver for precedence, and catalogues publish versions
        // without it, so keeping it would make two identical versions compare as different.
        string trimmed = raw.Split('+')[0].Trim();
        // The compiler's defaults. Their presence means the author never set a version, so they
        // say nothing about what was published and must not be reported as if they did.
        if (trimmed.Length == 0 || trimmed == "1.0.0.0" || trimmed == "0.0.0.0") return null;
        return trimmed;
    }

    /// <summary>
    /// The simple name of the attribute type, via its constructor.
    ///
    /// A MemberReference means the attribute is defined elsewhere (BepInEx, or the framework),
    /// which is the case for every attribute read here. A MethodDefinition would mean the type is
    /// declared in this same assembly; finding its name then means walking method ranges, which
    /// buys nothing — neither BepInPlugin nor the assembly attributes are ever declared locally.
    /// </summary>
    private static string? AttributeTypeName(MetadataReader md, CustomAttribute attribute)
    {
        if (attribute.Constructor.Kind != HandleKind.MemberReference) return null;

        MemberReference member = md.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
        return member.Parent.Kind switch
        {
            HandleKind.TypeReference => md.GetString(md.GetTypeReference((TypeReferenceHandle)member.Parent).Name),
            HandleKind.TypeDefinition => md.GetString(md.GetTypeDefinition((TypeDefinitionHandle)member.Parent).Name),
            _ => null
        };
    }

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    /// <summary>
    /// Breadth-first so the plugin's own DLL, which sits at the top, is reached before anything
    /// vendored underneath it. Depth-first would find a bundled dependency's assembly attributes
    /// first and report the plugin under them.
    /// </summary>
    private static IEnumerable<string> EnumerateDlls(string root, int maxDepth)
    {
        var queue = new Queue<(string Dir, int Depth)>();
        queue.Enqueue((root, 0));

        while (queue.Count > 0)
        {
            (string dir, int depth) = queue.Dequeue();

            string[] files;
            string[] subdirectories;
            try
            {
                files = Directory.GetFiles(dir, "*.dll");
                subdirectories = depth < maxDepth ? Directory.GetDirectories(dir) : [];
            }
            catch
            {
                continue;
            }

            foreach (string file in files) yield return file;
            foreach (string sub in subdirectories) queue.Enqueue((sub, depth + 1));
        }
    }
}
