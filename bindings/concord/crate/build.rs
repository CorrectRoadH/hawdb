// Copyright 2026 Nowledge
// SPDX-License-Identifier: Apache-2.0

fn main() {
    // Node supplies these symbols when loading the addon, not while linking it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-cdylib-link-arg=-Wl");
        println!("cargo:rustc-cdylib-link-arg=-undefined");
        println!("cargo:rustc-cdylib-link-arg=dynamic_lookup");
        // The Homebrew formula preserves this relocatable identity, keeping
        // the verified binary and its signature byte-for-byte intact.
        println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@rpath/hawdb.node");
    }
}
