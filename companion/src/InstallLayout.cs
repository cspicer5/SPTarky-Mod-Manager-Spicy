namespace SptarkyCompanion;

/// <summary>
/// Where this install keeps its two halves.
///
/// The server half and the client half are frequently NOT the same folder. A stock install puts
/// the server under a subfolder of the game — <c>D:\SPT</c> holds BepInEx and the game exe,
/// <c>D:\SPT\SPT</c> holds user/mods — and a server-only box may have no client half at all.
///
/// Both roots are found by MARKER rather than by name, because the name moved: SPT 4.0.x uses
/// <c>SPT\SPT</c> and 4.1 onwards uses <c>SPT\SPT_Runtime</c>. Nothing here reads either string,
/// so the rename is a non-event.
/// </summary>
public sealed class InstallLayout
{
    /// <summary>The folder containing <c>user/mods</c>. Null only if the server moved house mid-run.</summary>
    public string? ServerRoot { get; }

    /// <summary>The folder containing <c>BepInEx</c>. Null on a server with no game files beside it.</summary>
    public string? ClientRoot { get; }

    /// <summary>True when the two halves are different folders, which is the normal case.</summary>
    public bool Split => ServerRoot != null && ClientRoot != null && !PathsEqual(ServerRoot, ClientRoot);

    private InstallLayout(string? serverRoot, string? clientRoot)
    {
        ServerRoot = serverRoot;
        ClientRoot = clientRoot;
    }

    /// <summary>
    /// Works out both roots from where the server is running.
    ///
    /// SPT itself requires the process's working directory to BE the server root — Program
    /// refuses to start otherwise, checking for sptLogger.json there — so the current directory
    /// is a reliable starting point. It is still verified against the user/mods marker rather
    /// than trusted, and AppContext.BaseDirectory is tried as a fallback.
    /// </summary>
    public static InstallLayout Detect()
    {
        string? serverRoot = FirstWithMarker(
            [Directory.GetCurrentDirectory(), AppContext.BaseDirectory],
            candidate => Directory.Exists(Path.Combine(candidate, "user", "mods")));

        // Search upward from the server root: the client is normally the PARENT. The walk is
        // bounded because an unbounded one on a server-only box would climb to the drive root
        // and could match some unrelated BepInEx elsewhere on the disk.
        string? clientRoot = null;
        string? cursor = serverRoot ?? Directory.GetCurrentDirectory();
        for (int depth = 0; depth < 4 && cursor != null; depth++)
        {
            if (Directory.Exists(Path.Combine(cursor, "BepInEx")))
            {
                clientRoot = cursor;
                break;
            }
            cursor = Path.GetDirectoryName(cursor.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }

        return new InstallLayout(serverRoot, clientRoot);
    }

    private static string? FirstWithMarker(IEnumerable<string?> candidates, Func<string, bool> hasMarker)
    {
        foreach (string? candidate in candidates)
        {
            if (string.IsNullOrEmpty(candidate)) continue;
            try
            {
                string full = Path.GetFullPath(candidate);
                if (hasMarker(full)) return full;
            }
            catch
            {
                // A malformed candidate is not worth failing the whole manifest over.
            }
        }
        return null;
    }

    private static bool PathsEqual(string a, string b) =>
        string.Equals(
            Path.GetFullPath(a).TrimEnd(Path.DirectorySeparatorChar),
            Path.GetFullPath(b).TrimEnd(Path.DirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase);
}
