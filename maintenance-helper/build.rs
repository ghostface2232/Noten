fn main() {
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");

    if std::env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../src-tauri/icons/icon.ico");
        res.set("ProductName", "Noten");
        res.set("FileDescription", "Noten Maintenance Helper");
        res.set("ProductVersion", "0.1.3");
        res.set("LegalCopyright", "\u{00a9} 2026 Mingwan Bae");
        res.compile().expect("Failed to compile Windows resources");
    }
}
