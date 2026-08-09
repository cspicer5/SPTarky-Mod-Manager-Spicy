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
/// REGISTERED AS <see cref="StaticRouter"/>, NOT AS ITSELF. <c>HttpRouter</c> is constructed
/// with <c>IEnumerable&lt;StaticRouter&gt;</c>, so a router registered only under its own
/// concrete type is never in the collection that gets asked to handle a request. The failure
/// is silent and misleading: the mod loads, <c>ModValidator</c> reports it happily, the
/// request is logged as received — and the server answers
/// <c>UNHANDLED RESPONSE: /sptarky/version</c> with nothing anywhere explaining why.
/// </para>
/// <para>
/// Note the injection type is left at its default. SPT's own routers are all
/// <c>[Injectable]</c> with no arguments, and <c>Injectable</c>'s first parameter already
/// defaults to <c>Scoped</c> — passing it explicitly changes nothing, which cost one
/// build-and-restart cycle to discover.
/// </para>
/// </summary>
[Injectable(typeOverride: typeof(StaticRouter))]
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
