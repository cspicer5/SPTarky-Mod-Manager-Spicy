using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.DI;
using SPTarkov.Server.Core.Utils;
using SPTarkov.Server.Core.Models.Utils;

namespace SptarkyCompanion;

/// <summary>
/// The companion's HTTP surface.
///
/// Every route is a GET that reads and returns; there is deliberately no route that writes,
/// installs or removes anything. That is the security model — not a permission to be checked,
/// but an absence of anything to call.
///
/// <para>
/// UNFINISHED: the router loads and is constructed, but its routes are never matched — the
/// server answers <c>UNHANDLED RESPONSE</c>. Decompiling settled most of the surrounding
/// questions: <c>Router.CanHandle</c> is an exact string match so the route is fine;
/// <c>HttpRouter</c> is Scoped and takes <c>IEnumerable&lt;StaticRouter&gt;</c>; and
/// <c>DependencyInjectionHandler</c> already registers a component under every base type, so
/// a plain <c>[Injectable]</c> should be enough.
/// </para>
/// <para>
/// The measurement that narrows it: this constructor runs ONCE PER SERVER START, not per
/// request. Since <c>HttpRouter</c> is Scoped, anything in its collection would be built on
/// every request — so this is registered somewhere, but not there. The remaining unknown is
/// <c>DependencyInjectionHandler.RegisterComponent</c>.
/// </para>
/// <para>
/// Two dead ends, recorded so they are not retried. <c>typeOverride</c> means REPLACE, not
/// "also register as" — <c>InjectAll</c> excludes every type named as an override. And the
/// injection type is already <c>Scoped</c> by default, so passing it explicitly changes
/// nothing.
/// </para>
/// </summary>
[Injectable]
public class SptarkyRouter : StaticRouter
{
    /// <summary>
    /// Bumped only when the contract changes in a way an older manager would MISREAD. A
    /// manager seeing a higher number than it knows refuses to use the companion rather than
    /// guessing at fields whose meaning may have moved.
    /// </summary>
    private const int Protocol = 1;

    private const string CompanionVersion = "1.0.0";

    public SptarkyRouter(JsonUtil jsonUtil, ISptLogger<SptarkyRouter> logger) : base(
        jsonUtil,
        [
            new RouteAction(
                "/singleplayer/sptarky/version",
                // Signature fixed by SPT: (url, body, sessionId, output) -> object.
                // This route takes no input at all.
                (_, _, _, _) => new ValueTask<object>(new VersionResponse
                {
                    Version = CompanionVersion,
                    Protocol = Protocol,
                    Capabilities = []
                }),
                typeof(object)),
            new RouteAction(
                "/sptarky/version",
                (_, _, _, _) => new ValueTask<object>(new VersionResponse { Version = CompanionVersion, Protocol = Protocol, Capabilities = [] }),
                typeof(object)),
            new RouteAction(
                "/client/sptarky/version",
                (_, _, _, _) => new ValueTask<object>(new VersionResponse { Version = CompanionVersion, Protocol = Protocol, Capabilities = [] }),
                typeof(object))
        ])
    {
        // Said out loud at startup, so "is the companion actually running?" is answered by
        // the server's own log rather than by probing it from somewhere else.
        logger.Success(
            $"[Spicy's Tarky Mod Manager Companion] active — v{CompanionVersion}, protocol {Protocol}. " +
            "Serving /sptarky/version");
    }
}

/// <summary>
/// What <c>/sptarky/version</c> returns.
///
/// <c>Capabilities</c> is a list of names rather than booleans or an inference from the
/// version number, so the manager asks "can you do X" instead of "are you new enough to do X"
/// — which keeps this mod's release history out of the client entirely.
/// </summary>
public class VersionResponse
{
    public string Version { get; set; }
    public int Protocol { get; set; }
    public List<string> Capabilities { get; set; } = [];
}
