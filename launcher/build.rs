//! Icon and version info, plus the payload: launcher/payload/{game,extra} packed into the exe, so the release is
//! one file (SA-Coop-Setup.exe). Without that folder the exe looks for game\ and extra\ next to itself instead.
use std::io::Write;
use std::path::Path;

fn pack(dir: &Path, rel: &str, out: &mut Vec<(String, Vec<u8>)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = format!("{rel}{}", e.file_name().to_string_lossy());
        let p = e.path();
        if p.is_dir() {
            pack(&p, &format!("{name}/"), out);
        } else if let Ok(b) = std::fs::read(&p) {
            out.push((name, b));
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=assets/sa-coop.rc");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=payload");
    embed_resource::compile("assets/sa-coop.rc", embed_resource::NONE).manifest_optional().unwrap();

    // format: u32 count, then per file: u16 name length, name (UTF-8, '/' separated), u64 size, bytes
    let mut files = vec![];
    pack(Path::new("payload"), "", &mut files);
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("payload.bin");
    let mut f = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    f.write_all(&(files.len() as u32).to_le_bytes()).unwrap();
    for (name, data) in &files {
        f.write_all(&(name.len() as u16).to_le_bytes()).unwrap();
        f.write_all(name.as_bytes()).unwrap();
        f.write_all(&(data.len() as u64).to_le_bytes()).unwrap();
        f.write_all(data).unwrap();
    }
}
