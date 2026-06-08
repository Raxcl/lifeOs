use std::{fs, path::Path, time::UNIX_EPOCH};

fn icon_stamp(path: &Path) -> String {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return "missing".to_string(),
    };

    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    format!("{}:{modified}", metadata.len())
}

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!(
        "cargo:rustc-env=LIFEOS_ICON_STAMP={}",
        icon_stamp(Path::new("icons/icon.png"))
    );

    tauri_build::build()
}
