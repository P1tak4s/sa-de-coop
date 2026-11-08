fn main() {
    println!("cargo:rerun-if-changed=assets/sa-coop.rc");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    embed_resource::compile("assets/sa-coop.rc", embed_resource::NONE).manifest_optional().unwrap();
}
