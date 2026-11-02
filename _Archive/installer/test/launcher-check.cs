// Compiled with packaging/launcher/Launcher.cs by launcher.test.js to check the launcher's own
// logic. Takes the folder to unpack into and prints "ok" when every check passes.
using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;

internal static class LauncherCheck
{
    private static int failures;

    private static void Check(bool ok, string what)
    {
        if (ok) return;
        failures++;
        Console.WriteLine("FAIL " + what);
    }

    private static void Write(ZipArchive zip, string name, string body)
    {
        using (StreamWriter w = new StreamWriter(zip.CreateEntry(name).Open(), new UTF8Encoding(false))) w.Write(body);
    }

    private static ZipArchive Zip(params string[] names)
    {
        MemoryStream ms = new MemoryStream();
        using (ZipArchive zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            foreach (string name in names)
            {
                if (name.EndsWith("/")) zip.CreateEntry(name);
                else Write(zip, name, name);
            }
        }
        ms.Position = 0;
        return new ZipArchive(ms, ZipArchiveMode.Read);
    }

    // A freshly unpacked folder, marked as complete, with one file in it.
    private static string Unpacked(string root, string id, string who)
    {
        string partial = root + ".partial-" + id;
        Directory.CreateDirectory(partial);
        File.WriteAllText(Path.Combine(partial, ".unpacked"), who);
        File.WriteAllText(Path.Combine(partial, "file.txt"), who);
        return partial;
    }

    // Opens a file the way antivirus does while it checks it: nothing else can rename or delete it.
    private static FileStream Hold(string path)
    {
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
    }

    private static int[] Waits(int count, int ms)
    {
        int[] waits = new int[count];
        for (int i = 0; i < count; i++) waits[i] = ms;
        return waits;
    }

    private static void CheckMoves(string home)
    {
        int total = 0;
        foreach (int ms in Launcher.MoveWaits) total += ms;
        Check(total >= 30000 && total <= 60000, "waits 30 to 60 seconds in all, not " + total + " ms");

        // Held for about a second, as antivirus does with new files: waits, then moves it.
        string heldRoot = Path.Combine(home, "held");
        string heldPartial = Unpacked(heldRoot, "1", "mine");
        FileStream held = Hold(Path.Combine(heldPartial, "file.txt"));
        Thread release = new Thread(() => { Thread.Sleep(1000); held.Dispose(); });
        release.Start();
        try { Launcher.MoveIntoPlace(heldPartial, heldRoot, Waits(20, 250)); }
        catch (Exception e) { Check(false, "moves once the file is let go: " + e.Message); }
        release.Join();
        Check(Read(Path.Combine(heldRoot, ".unpacked")) == "mine" && File.Exists(Path.Combine(heldRoot, "file.txt")), "moved after the file was let go");
        Check(!Directory.Exists(heldPartial), "nothing left behind after the wait");

        // Another copy finishes while this one waits: keeps theirs and drops this one.
        string racedRoot = Path.Combine(home, "raced");
        string racedPartial = Unpacked(racedRoot, "2", "mine");
        using (Hold(Path.Combine(racedPartial, "file.txt")))
        {
            Thread other = new Thread(() =>
            {
                Thread.Sleep(500);
                Directory.Move(Unpacked(racedRoot, "3", "theirs"), racedRoot);
            });
            other.Start();
            try { Launcher.MoveIntoPlace(racedPartial, racedRoot, Waits(20, 250)); }
            catch (Exception e) { Check(false, "sees the other copy finish while it waits: " + e.Message); }
            other.Join();
        }
        Check(Read(Path.Combine(racedRoot, ".unpacked")) == "theirs", "the copy that finished first is kept");

        // Another copy finished before this one tried.
        string beatenRoot = Path.Combine(home, "beaten");
        Directory.Move(Unpacked(beatenRoot, "4", "theirs"), beatenRoot);
        string beatenPartial = Unpacked(beatenRoot, "5", "mine");
        Launcher.MoveIntoPlace(beatenPartial, beatenRoot, Waits(1, 10));
        Check(Read(Path.Combine(beatenRoot, ".unpacked")) == "theirs" && !Directory.Exists(beatenPartial), "keeps the finished copy and removes this one");

        // Left half unpacked by a run that was stopped: replaced.
        string stoppedRoot = Path.Combine(home, "stopped");
        Directory.CreateDirectory(stoppedRoot);
        File.WriteAllText(Path.Combine(stoppedRoot, "stale.txt"), "old");
        Launcher.MoveIntoPlace(Unpacked(stoppedRoot, "6", "mine"), stoppedRoot, Waits(1, 10));
        Check(Read(Path.Combine(stoppedRoot, ".unpacked")) == "mine" && !File.Exists(Path.Combine(stoppedRoot, "stale.txt")), "a half-unpacked folder is replaced");

        // A half-unpacked folder Windows won't delete yet says "access denied" (UnauthorizedAccessException) instead.
        string deniedRoot = Path.Combine(home, "denied");
        Directory.CreateDirectory(deniedRoot);
        string readOnly = Path.Combine(deniedRoot, "stale.txt");
        File.WriteAllText(readOnly, "old");
        File.SetAttributes(readOnly, FileAttributes.ReadOnly);
        Thread allow = new Thread(() => { Thread.Sleep(500); File.SetAttributes(readOnly, FileAttributes.Normal); });
        allow.Start();
        try { Launcher.MoveIntoPlace(Unpacked(deniedRoot, "8", "mine"), deniedRoot, Waits(20, 250)); }
        catch (Exception e) { Check(false, "retries while access is denied: " + e.Message); }
        allow.Join();
        Check(Read(Path.Combine(deniedRoot, ".unpacked")) == "mine" && !File.Exists(readOnly), "replaced once access was allowed");

        // Still held after the last wait: a plain message saying what to do.
        string stuckRoot = Path.Combine(home, "stuck");
        string stuckPartial = Unpacked(stuckRoot, "7", "mine");
        using (Hold(Path.Combine(stuckPartial, "file.txt")))
        {
            try
            {
                Launcher.MoveIntoPlace(stuckPartial, stuckRoot, Waits(2, 10));
                Check(false, "gives up while the file stays held");
            }
            catch (IOException e)
            {
                foreach (string part in new[] { home, "antivirus", "run it again" }) Check(e.Message.Contains(part), "message when it gives up says " + part + ": " + e.Message);
            }
        }
        Check(!Directory.Exists(stuckRoot), "nothing moved when it gives up");
    }

    private static string Read(string path)
    {
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }

    // Other versions go. This version, a copy unpacking right now and the PAX route's state stay.
    private static void CheckCleanup(string home)
    {
        string current = "0.2.0-bbbbbbbbbb";
        string[] kept = { current, "pax", "PAX-Run", "managed-app", "0.2.0-cccccccccc.partial-1" };
        string[] gone = { "0.1.0-aaaaaaaaaa", "~stale", "pax2" };
        foreach (string dir in kept) File.WriteAllText(Path.Combine(Directory.CreateDirectory(Path.Combine(home, dir)).FullName, "file.txt"), dir);
        foreach (string dir in gone) File.WriteAllText(Path.Combine(Directory.CreateDirectory(Path.Combine(home, dir)).FullName, "file.txt"), dir);
        Launcher.RemoveOtherVersions(home, current);
        foreach (string dir in kept) Check(Read(Path.Combine(home, dir, "file.txt")) == dir, "cleanup keeps " + dir);
        foreach (string dir in gone) Check(!Directory.Exists(Path.Combine(home, dir)), "cleanup removes " + dir);
        Check(Directory.GetDirectories(home).Length == kept.Length, "cleanup leaves nothing else: " + string.Join(", ", Directory.GetDirectories(home)));
        Check(Launcher.Kept("pax") && Launcher.Kept("Pax-Run") && Launcher.Kept("MANAGED-APP"), "the PAX route's folders are kept whatever their case");
        Check(!Launcher.Kept("pax2") && !Launcher.Kept("0.2.0-pax") && !Launcher.Kept(""), "only those folders are kept");
    }

    private static int Main(string[] args)
    {
        string dest = Path.Combine(args[0], "unpacked");

        Check(Launcher.Quote("plain") == "plain", "plain argument");
        Check(Launcher.Quote("") == "\"\"", "empty argument");
        Check(Launcher.Quote("a b") == "\"a b\"", "argument with a space");
        Check(Launcher.Quote("C:\\Program Files\\x\\") == "\"C:\\Program Files\\x\\\\\"", "argument ending in a backslash");
        Check(Launcher.Quote("say \"hi\"") == "\"say \\\"hi\\\"\"", "argument with quotes");

        foreach (string ok in new[] { "node\\node.exe", "f\\", "f\\installer\\x.js", "f\\Classic Editions\\3. Fabric\\AI-in-One Dashboard - Fabric.pbit" })
        {
            Check(Launcher.SafeEntry(ok), "safe entry " + ok);
        }
        foreach (string bad in new[] { "", "\\x", "..\\x", "f\\..\\..\\x", "C:\\x", "f\\.\\x", "f\\\\x", "f\\x.", "f\\x " })
        {
            Check(!Launcher.SafeEntry(bad), "unsafe entry " + bad);
        }

        string deep = string.Join("/", new[] { "f", new string('a', 80), new string('b', 80), new string('c', 80), "file.js" });
        // The deploy sources sit in folders with spaces and dots in their names.
        string spaced = "f/Classic Editions/3. Fabric/notebooks/Copilot Notebook.ipynb";
        using (ZipArchive zip = Zip("node/", "node/node.exe", "f/empty/", deep, spaced)) Launcher.Extract(zip, dest);
        string longFile = Launcher.Long(dest) + "\\" + deep.Replace('/', '\\');
        Check(longFile.Length > 300, "unpacked path is only " + longFile.Length + " characters");
        Check(File.ReadAllText(longFile) == deep, "file past 260 characters");
        Check(File.ReadAllText(Path.Combine(dest, "node", "node.exe")) == "node/node.exe", "short file");
        Check(Read(Path.Combine(dest, "f", "Classic Editions", "3. Fabric", "notebooks", "Copilot Notebook.ipynb")) == spaced, "file in folders with spaces and dots");
        Check(Directory.Exists(Path.Combine(dest, "f", "empty")), "empty folder");

        string outside = Path.Combine(args[0], "evil.txt");
        try
        {
            using (ZipArchive zip = Zip("../evil.txt")) Launcher.Extract(zip, Path.Combine(args[0], "damaged"));
            Check(false, "entry outside the folder is refused");
        }
        catch (InvalidDataException) { }
        Check(!File.Exists(outside), "nothing written outside the folder");

        Directory.Delete(Launcher.Long(dest), true);
        Check(!Directory.Exists(dest), "unpacked folder removed");

        CheckMoves(Path.Combine(args[0], "home"));
        CheckCleanup(Path.Combine(args[0], "versions"));

        Check(Launcher.AwakeFlags == 0x80000001, "keep-awake asks for ES_CONTINUOUS | ES_SYSTEM_REQUIRED");
        Check(Launcher.KeepAwake(true), "keep-awake turned on");
        Check(Launcher.KeepAwake(false), "keep-awake reset");

        Check(Launcher.BlockedByPolicy(1260) && Launcher.BlockedByPolicy(4551), "AppLocker and App Control blocks are spotted");
        Check(!Launcher.BlockedByPolicy(2), "a missing file isn't a policy block");
        string policy = Launcher.PolicyMessage("C:\\x\\node.exe");
        foreach (string part in new[] { "C:\\x\\node.exe", "Don't work around it", "Company Portal", "#it-approved-nodejs", "#locked-down-tenant--azure-cloud-shell", "ask your IT team" })
        {
            Check(policy.Contains(part), "policy message says " + part);
        }

        Console.WriteLine(failures == 0 ? "ok" : failures + " failed");
        return failures == 0 ? 0 : 1;
    }
}
