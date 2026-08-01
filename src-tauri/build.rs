fn main() {
    // A standalone debug build also embeds the current Vite output when it is
    // compiled with the custom-protocol feature.  Without this explicit
    // dependency Cargo can reuse an old Tauri resource archive after only
    // frontend files changed.
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    // The Windows taskbar icon is embedded in the executable. Cargo must
    // rebuild when the source icon changes, otherwise an old green icon can
    // remain in an already-installed debug binary.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
