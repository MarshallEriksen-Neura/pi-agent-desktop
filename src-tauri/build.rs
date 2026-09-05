fn main() {
    tauri_build::build();

    #[cfg(windows)]
    println!(
        "cargo:rustc-link-search=native={}",
        std::env::var("OUT_DIR").unwrap()
    );
}
