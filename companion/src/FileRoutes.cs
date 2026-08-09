using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;
using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.DI;
using SPTarkov.Server.Core.Models.Common;
using SPTarkov.Server.Core.Models.Utils;
using SPTarkov.Server.Core.Utils;

namespace SptarkyCompanion;

/// <summary>
/// Serving a mod's files, so a client can install from the server it is joining rather than from
/// the catalogue.
///
/// <para>
/// Two routes, deliberately named so that NEITHER string is a substring of the other:
/// SPT matches dynamic routes with <c>url.Contains(route)</c> and then runs EVERY router that
/// matches, so "/sptarky/file" would also swallow "/sptarky/files/..." and the last writer would
/// win. "filelist" and "filedata" cannot collide.
/// </para>
/// <para>
/// Both are GETs that read. There is no upload, no delete, and no route that writes anything —
/// the restriction is structural rather than a permission that could be widened later.
/// </para>
/// </summary>
[Injectable]
public class SptarkyFileRouter : DynamicRouter
{
    /// <summary>Returned instead of a body to tell <see cref="SptarkyFileSerializer"/> to stream the file.</summary>
    public const string FileSentinel = "SPTARKY_FILE";

    public const string ListRoute = "/sptarky/filelist/";
    public const string DataRoute = "/sptarky/filedata/";

    public SptarkyFileRouter(JsonUtil jsonUtil, HttpResponseUtil httpResponseUtil)
        : base(
            jsonUtil,
            [
                new RouteAction(ListRoute, (url, _, _, _) => new ValueTask<object>(httpResponseUtil.NoBody(ListFiles(url)))),

                // Binary cannot travel the normal path: a route action's result is cast with
                // `as string`, so anything that is not a string becomes null. SPT's own answer to
                // this is a sentinel — the action returns a marker and an ISerializer recognises
                // it and writes the response itself. That is exactly how bundles are served.
                new RouteAction(DataRoute, (url, _, _, _) =>
                {
                    // Resolved HERE as well as in the serializer so a bad path fails as honest
                    // JSON rather than as a sentinel that the serializer then silently drops.
                    string? resolved = FilePaths.Resolve(InstallLayout.Detect(), url, DataRoute);
                    return new ValueTask<object>(resolved != null && File.Exists(resolved)
                        ? FileSentinel
                        : httpResponseUtil.NoBody(new FileListing { Error = "No such file." }));
                })
            ])
    {
    }

    private static FileListing ListFiles(string url)
    {
        var listing = new FileListing();
        InstallLayout layout = InstallLayout.Detect();
        string? modRoot = FilePaths.Resolve(layout, url, ListRoute);
        if (modRoot == null || !Directory.Exists(modRoot))
        {
            listing.Error = "No such mod on this server.";
            return listing;
        }

        try
        {
            foreach (string file in Directory.EnumerateFiles(modRoot, "*", SearchOption.AllDirectories))
            {
                // Relative, and always with forward slashes: the client asking for these may not
                // be on Windows, and the path goes back out over a URL either way.
                string rel = Path.GetRelativePath(modRoot, file).Replace('\\', '/');
                listing.Files.Add(new FileEntry { Path = rel, SizeBytes = new FileInfo(file).Length });
            }
        }
        catch (Exception ex)
        {
            listing.Error = $"Could not read that mod's files: {ex.Message}";
        }
        return listing;
    }
}

/// <summary>
/// Writes the bytes once <see cref="SptarkyFileRouter"/> has said the request is for a real file.
///
/// It re-derives the path from the request rather than being handed one, because the sentinel is
/// the only thing that travels between the two — and re-resolving through the same containment
/// check means the check cannot be bypassed by whatever produced the sentinel.
/// </summary>
[Injectable]
public class SptarkyFileSerializer : ISerializer
{
    private readonly HttpFileUtil _httpFileUtil;

    public SptarkyFileSerializer(HttpFileUtil httpFileUtil)
    {
        _httpFileUtil = httpFileUtil;
    }

    public bool CanHandle(string route) => route == SptarkyFileRouter.FileSentinel;

    public async Task Serialize(MongoId sessionID, HttpRequest req, HttpResponse resp, object? body)
    {
        string? resolved = FilePaths.Resolve(InstallLayout.Detect(), req.Path.Value ?? "", SptarkyFileRouter.DataRoute);
        if (resolved == null || !File.Exists(resolved))
        {
            resp.StatusCode = 404;
            return;
        }
        await _httpFileUtil.SendFile(resp, resolved);
    }
}

/// <summary>
/// Turning a request URL into a path on disk, or refusing to.
///
/// This is the whole security surface of file serving, so it is one function with one rule: the
/// resolved path must be INSIDE the mod area it names. The check is done on canonical full paths
/// after resolution, which is what makes it robust — "..", absolute paths, and anything clever
/// with separators all collapse before the comparison rather than having to be pattern-matched
/// out beforehand.
/// </summary>
public static class FilePaths
{
    /// <summary>
    /// URL shape: <c>{prefix}{server|client}/{rest of relative path}</c>.
    /// Returns null for anything outside the mod area, or that names neither half.
    /// </summary>
    public static string? Resolve(InstallLayout layout, string url, string prefix)
    {
        int at = url.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return null;

        string remainder = url[(at + prefix.Length)..].Trim('/');
        if (remainder.Length == 0) return null;

        // Strip a query string; ASP.NET keeps it out of Path.Value but the router's dynamic
        // match hands over whatever was requested, and this is also reachable from tests.
        int query = remainder.IndexOf('?');
        if (query >= 0) remainder = remainder[..query];

        int slash = remainder.IndexOf('/');
        string half = (slash < 0 ? remainder : remainder[..slash]).ToLowerInvariant();
        string relative = slash < 0 ? "" : remainder[(slash + 1)..];
        if (relative.Length == 0) return null;

        string? area = half switch
        {
            "server" => layout.ServerRoot == null ? null : Path.Combine(layout.ServerRoot, "user", "mods"),
            "client" => layout.ClientRoot == null ? null : Path.Combine(layout.ClientRoot, "BepInEx", "plugins"),
            _ => null
        };
        if (area == null) return null;

        return Within(area, Uri.UnescapeDataString(relative));
    }

    /// <summary>
    /// The containment check. Null unless <paramref name="relative"/> lands strictly inside
    /// <paramref name="root"/>.
    /// </summary>
    public static string? Within(string root, string relative)
    {
        try
        {
            string fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            string combined = Path.GetFullPath(Path.Combine(fullRoot, relative));

            // The separator matters: without it "C:\mods" would also accept "C:\mods-backup".
            // Comparing case-insensitively is correct on Windows, which is where SPT runs.
            return combined.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                ? combined
                : null;
        }
        catch
        {
            // A path too long or with invalid characters is a refusal, not a crash.
            return null;
        }
    }
}

public class FileListing
{
    [JsonPropertyName("files")]
    public List<FileEntry> Files { get; set; } = [];

    /// <summary>Set when the listing could not be produced. Null on success.</summary>
    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

public class FileEntry
{
    /// <summary>Relative to the mod's own folder, forward-slashed.</summary>
    [JsonPropertyName("path")]
    public string Path { get; set; } = "";

    [JsonPropertyName("sizeBytes")]
    public long SizeBytes { get; set; }
}
