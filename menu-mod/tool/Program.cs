// MenuPatch: adds a "co-op" entry (FunctionToCallOnPress "COOP") before "exit"
// in GTA SA DE menu templates. Reads extracted originals, writes copies to work/.
// Usage: MenuPatch dump <file.uasset>
//        MenuPatch patch <srcRoot> <dstRoot>   (roots contain Gameface/...)
using UAssetAPI;
using UAssetAPI.ExportTypes;
using UAssetAPI.PropertyTypes.Objects;
using UAssetAPI.UnrealTypes;

static class Program
{
    const string Rel = "Gameface/Content/SanAndreas/UI/MenuTemplates";
    static readonly string[] Menus = { "GTASA_MainMenu", "GTASA_PauseMenu" };

    static int Main(string[] a)
    {
        if (a.Length >= 2 && a[0] == "dump") { Dump(new UAsset(a[1], EngineVersion.VER_UE4_26)); return 0; }
        if (a.Length >= 3 && a[0] == "roundtrip") { new UAsset(a[1], EngineVersion.VER_UE4_26).Write(a[2]); return 0; }
        if (a.Length >= 3 && a[0] == "patch")
        {
            foreach (var m in Menus)
            {
                var src = Path.Combine(a[1], Rel, m + ".uasset");
                var dst = Path.Combine(a[2], Rel, m + ".uasset");
                var asset = new UAsset(src, EngineVersion.VER_UE4_26);
                Console.WriteLine($"=== {m} BEFORE"); Dump(asset);
                Patch(asset);
                Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
                asset.Write(dst);
                Console.WriteLine($"=== {m} AFTER (re-read)"); Dump(new UAsset(dst, EngineVersion.VER_UE4_26));
            }
            return 0;
        }
        Console.Error.WriteLine("usage: dump <uasset> | patch <srcRoot> <dstRoot>");
        return 1;
    }

    static NormalExport Main0(UAsset asset) =>
        asset.Exports.OfType<NormalExport>().First(e => e.Data.Any(p => p.Name.ToString() == "LeftButtons"));

    static string Show(PropertyData p) => p switch
    {
        TextPropertyData t => $"Text(ns='{t.Namespace}', key='{t.Value}', src='{t.CultureInvariantString}', hist={t.HistoryType}, flags={t.Flags})",
        StrPropertyData s => $"'{s.Value}'",
        NamePropertyData n => $"Name({n.Value})",
        ObjectPropertyData o => $"Obj({o.Value.Index})",
        SoftObjectPropertyData so => $"Soft({so.Value.AssetPath.PackageName}/{so.Value.AssetPath.AssetName})",
        _ => $"{p.GetType().Name}:{p.RawValue}"
    };

    static void Dump(UAsset asset)
    {
        foreach (var e in asset.Exports.OfType<NormalExport>())
        {
            Console.WriteLine($"-- export {e.ObjectName} ({e.GetExportClassType()})");
            foreach (var p in e.Data)
            {
                if (p is ArrayPropertyData arr)
                {
                    Console.WriteLine($"  {p.Name} : Array<{arr.ArrayType}> [{arr.Value.Length}]");
                    for (int i = 0; i < arr.Value.Length; i++)
                    {
                        string s;
                        try { s = arr.Value[i] is ObjectPropertyData o ? ObjStr(asset, o) : Show(arr.Value[i]); }
                        catch (Exception ex) { s = "?" + ex.Message; }
                        Console.WriteLine($"    [{i}] {s}");
                    }
                }
                else
                {
                    string s;
                    try { s = p is ObjectPropertyData o ? ObjStr(asset, o) : Show(p); } catch (Exception ex) { s = "?" + ex.Message; }
                    Console.WriteLine($"  {p.Name} ({p.PropertyType}) = {s}");
                }
            }
        }
    }

    static string ObjStr(UAsset asset, ObjectPropertyData o)
    {
        var idx = o.Value;
        if (idx.IsNull()) return "null";
        if (idx.IsImport()) return "Import:" + idx.ToImport(asset).ObjectName;
        return "Export:" + idx.ToExport(asset).ObjectName;
    }

    static void Patch(UAsset asset)
    {
        var e = Main0(asset);
        var left = (ArrayPropertyData)e.Data.First(p => p.Name.ToString() == "LeftButtons");
        int exitIdx = Array.FindIndex(left.Value, v => v is TextPropertyData t && t.CultureInvariantString?.Value?.ToLowerInvariant() == "exit");
        if (exitIdx < 0) exitIdx = Array.FindLastIndex(left.Value, v => v is TextPropertyData t && (t.CultureInvariantString?.Value ?? "").ToLowerInvariant().Contains("quit"));
        if (exitIdx < 0) throw new Exception("exit entry not found");
        if (left.Value.Any(v => v is TextPropertyData t && t.CultureInvariantString?.Value == "co-op"))
            throw new Exception("already patched");
        int n = left.Value.Length;
        Console.WriteLine($"   insert at index {exitIdx} (LeftButtons length {n})");

        // Only these are index-parallel to LeftButtons. LeftButtonSelectedBackgroundOverride is shorter
        // (exit has no entry) and is left untouched, so co-op, like exit, gets no override texture.
        string[] parallel = { "LeftButtons", "SelectorTabs", "FunctionToCallOnPress" };
        foreach (var p in e.Data.OfType<ArrayPropertyData>().Where(p => parallel.Contains(p.Name.ToString())))
        {
            if (p.Value.Length != n) throw new Exception($"{p.Name} length {p.Value.Length} != {n}");
            var tmpl = p.Value[exitIdx];
            PropertyData ins = p.Name.ToString() switch
            {
                "LeftButtons" => NewText(asset, (TextPropertyData)tmpl, "co-op"),
                "FunctionToCallOnPress" => NewStr(asset, (StrPropertyData)tmpl, "COOP"),
                _ => EmptyLike(asset, tmpl, p.Name.ToString()),
            };
            var list = p.Value.ToList(); list.Insert(exitIdx, ins); p.Value = list.ToArray();
            Console.WriteLine($"   {p.Name}: inserted {ins.GetType().Name}");
        }
    }

    static TextPropertyData NewText(UAsset asset, TextPropertyData t, string src)
    {
        var n = (TextPropertyData)t.Clone();
        n.Namespace = new FString("");
        n.Value = new FString(Guid.NewGuid().ToString("N").ToUpperInvariant());
        n.CultureInvariantString = new FString(src);
        return n;
    }

    static StrPropertyData NewStr(UAsset asset, StrPropertyData s, string v)
    {
        var n = (StrPropertyData)s.Clone(); n.Value = new FString(v); return n;
    }

    // For other parallel arrays: an "empty" element of the same type (null object ref, empty string, empty text).
    static PropertyData EmptyLike(UAsset asset, PropertyData tmpl, string arrayName)
    {
        var n = (PropertyData)tmpl.Clone();
        switch (n)
        {
            case ObjectPropertyData o: o.Value = FPackageIndex.FromRawIndex(0); break;
            case SoftObjectPropertyData so: so.Value = new FSoftObjectPath(); break;
            case StrPropertyData s: s.Value = new FString(""); break;
            case TextPropertyData t: t.Value = new FString(Guid.NewGuid().ToString("N").ToUpperInvariant()); t.Namespace = new FString(""); t.CultureInvariantString = new FString(""); break;
            case BoolPropertyData b: b.Value = false; break;
            default: throw new Exception($"no empty value rule for {arrayName} element {n.GetType().Name}");
        }
        return n;
    }
}
