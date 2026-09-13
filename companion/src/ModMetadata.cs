using SPTarkov.Server.Core.Models.Spt.Mod;
// Aliased rather than imported wholesale: `Version` and `Range` both collide with System
// types that implicit usings bring in, and the resulting error names neither culprit.
using SemVersion = SemanticVersioning.Version;
using SemRange = SemanticVersioning.Range;

namespace SptarkyCompanion;

/// <summary>
/// Identity of the SPTarky server companion.
///
/// This mod exists because a stock SPT server cannot answer three questions the SPTarky Mod
/// Manager needs, established by probing a live 4.0.13 server:
///
///   * client mods — the server never sees the client's BepInEx folder, and no endpoint
///     exposes one;
///   * true installed versions — /launcher/server/loadedServerMods reports what each mod
///     DECLARES, which is wrong whenever an author forgets to bump it;
///   * mod files — /files/ serves bundles only.
///
/// It is read-only by construction. There are no routes that write, install or delete, so it
/// cannot be driven to do more than report — the restriction is structural rather than a
/// setting somebody can widen.
///
/// <para>
/// 4.0 declared this contract as the abstract CLASS <c>AbstractModMetadata</c> with eleven
/// abstract properties; 4.1 replaced it with the INTERFACE <c>IModMetadata</c>, dropped
/// <c>IsBundleMod</c> and added <c>HasPrepatcher</c>. Overriding and implementing cannot share a
/// declaration, so the property list appears twice — but every value it reports is declared once,
/// below, because two identities that drift apart would be far worse than two declarations that
/// look alike.
/// </para>
/// </summary>
public partial record SptarkyCompanionMetadata
{
    private const string Id = "com.sptarky.companion";
    private const string DisplayName = "SPTarky Companion";
    private const string AuthorName = "cspicer5";
    private const string Repository = "https://github.com/cspicer5/SPTarky-Mod-Manager-Spicy";
    private const string LicenceName = "MIT";

    /// <summary>
    /// Kept in step with the protocol the manager negotiates, NOT with the manager's own
    /// version. The two are released separately and a server is rarely updated in lockstep
    /// with the clients that talk to it.
    /// </summary>
    private static SemVersion DeclaredVersion => new(1, 0, 0);

    /// <summary>
    /// Everything this mod touches — the mod folders, the ledger files, the bundle cache —
    /// has been stable across 4.0 and 4.1, including the SPT_Runtime rename, because roots
    /// are resolved by marker rather than by name. The range stays open at the top on purpose:
    /// what actually gates a build is the runtime it was compiled for, and a 4.0 server cannot
    /// load the 4.1 assembly at all.
    /// </summary>
    private static SemRange SupportedSpt => new(">=4.0.0");
}

#if NET10_0_OR_GREATER

public partial record SptarkyCompanionMetadata : IModMetadata
{
    public string ModGuid { get; init; } = Id;
    public string Name { get; init; } = DisplayName;
    public string Author { get; init; } = AuthorName;
    public List<string>? Contributors { get; init; } = [];
    public SemVersion Version { get; init; } = DeclaredVersion;
    public SemRange SptVersion { get; init; } = SupportedSpt;

    /// <summary>Ships no prepatcher — it reports on other mods, and runs entirely server-side.</summary>
    public bool HasPrepatcher { get; init; }

    public List<string>? Incompatibilities { get; init; } = [];
    public Dictionary<string, SemRange>? ModDependencies { get; init; } = [];
    public string? Url { get; init; } = Repository;
    public string License { get; init; } = LicenceName;
}

#else

public partial record SptarkyCompanionMetadata : AbstractModMetadata
{
    public override string ModGuid { get; init; } = Id;
    public override string Name { get; init; } = DisplayName;
    public override string Author { get; init; } = AuthorName;
    // The four nullable annotations below are not a claim that these can be absent — every one
    // is initialized right here. They match how SPT declares them on the base class, which is
    // the only way to override without a nullability mismatch warning.
    public override List<string>? Contributors { get; init; } = [];
    public override SemVersion Version { get; init; } = DeclaredVersion;
    public override SemRange SptVersion { get; init; } = SupportedSpt;
    public override List<string>? Incompatibilities { get; init; } = [];
    public override Dictionary<string, SemRange>? ModDependencies { get; init; } = [];
    public override string? Url { get; init; } = Repository;

    /// <summary>Ships no bundles; it only ever reports on other mods'.</summary>
    public override bool? IsBundleMod { get; init; } = false;

    public override string License { get; init; } = LicenceName;
}

#endif
