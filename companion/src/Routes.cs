using SPTarkov.Server.Core.DI;

namespace SptarkyCompanion;

/// <summary>
/// Builds a <see cref="RouteAction"/> without every route having to know which SPT it is being
/// compiled for.
///
/// <para>
/// 4.1 added a <c>CancellationToken</c> to the action delegate, taking it from five type
/// arguments to six. Nothing else about a route changed — but the lambda's parameter count is
/// part of its signature, so without this every route site would carry its own <c>#if</c>. The
/// difference is worth isolating in exactly one place: a route that grew a discard in the wrong
/// branch still compiles, and the failure would surface as a route that is simply never reached.
/// </para>
/// <para>
/// Every companion route is a synchronous read of the URL, so <paramref name="handler"/> takes the
/// requested url and returns the already-serialized body. The token is discarded rather than
/// honoured because there is nothing here long enough to cancel — each handler is a directory
/// listing or a manifest read that completes in one pass.
/// </para>
/// </summary>
internal static class Routes
{
    public static RouteAction Get(string url, Func<string, object> handler) =>
#if NET10_0_OR_GREATER
        new(url, (requested, _, _, _, _) => new ValueTask<object>(handler(requested)));
#else
        new(url, (requested, _, _, _) => new ValueTask<object>(handler(requested)));
#endif
}
