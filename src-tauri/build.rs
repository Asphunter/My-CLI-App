fn main() {
    // A standalone debug build also embeds the current Vite output when it is
    // compiled with the custom-protocol feature.  Without this explicit
    // dependency Cargo can reuse an old Tauri resource archive after only
    // frontend files changed.
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
