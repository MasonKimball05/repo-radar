//! Command-line scan, printing the same JSON the app receives.
//!
//!     cargo run --example scan -- ~/Documents/GitHub

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: scan <folder>");
        std::process::exit(2);
    });
    match repo_radar_lib::scan::scan_root(std::path::Path::new(&root)) {
        Ok(result) => println!("{}", serde_json::to_string_pretty(&result).unwrap()),
        Err(e) => {
            eprintln!("scan failed: {e}");
            std::process::exit(1);
        }
    }
}
