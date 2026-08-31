fn main() {
    // Bake in which commit this binary came from. The app ships as an unsigned .dmg that people
    // re-download by hand, so without this there is no way to answer "which build are you
    // running?" — which is the first question worth asking about any bug report.
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let mut commit = git(&["rev-parse", "--short=7", "HEAD"]).unwrap_or_else(|| "unknown".into());
    // A build from a modified tree is not the commit it claims to be. Say so rather than lie.
    if git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty()) {
        commit.push('+');
    }
    println!("cargo:rustc-env=GP_COMMIT={commit}");

    // Seconds since the epoch, formatted by the UI in the viewer's own locale. Avoids pulling a
    // date crate in for one line.
    let built = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=GP_BUILT={built}");

    // Without this the commit is baked once and then goes stale for every later build.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/index");

    tauri_build::build()
}
