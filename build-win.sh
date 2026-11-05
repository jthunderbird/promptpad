#!/usr/bin/env bash
# Cross-compile a portable promptpad.exe for Windows x64 (MSVC target via cargo-xwin) in Docker.
# The WebView2 loader is linked statically and the C runtime is static, so the exe needs no DLLs
# beside it (only the WebView2 runtime that ships with Windows 10/11).
# Run `npm run build` first so dist/ holds the frontend.
set -euo pipefail
cd "$(dirname "$0")"
docker build -q -f Dockerfile.win -t promptpad-win . >/dev/null
docker run --rm -v "$PWD":/app -v promptpad-cargo:/usr/local/cargo/registry -v promptpad-target:/target -v promptpad-xwin:/xwin-cache \
  -e CARGO_TARGET_DIR=/target -e XWIN_ACCEPT_LICENSE=1 -e RUSTFLAGS="-C target-feature=+crt-static -C linker-flavor=lld-link -Lnative=/xwin-cache/xwin/crt/lib/x86_64 -Lnative=/xwin-cache/xwin/sdk/lib/um/x86_64 -Lnative=/xwin-cache/xwin/sdk/lib/ucrt/x86_64 -C link-arg=ucrt.lib" promptpad-win \
  cargo xwin build --release --target x86_64-pc-windows-msvc --features custom-protocol
mkdir -p release
docker run --rm -v "$PWD":/app -v promptpad-target:/target promptpad-win \
  cp /target/x86_64-pc-windows-msvc/release/promptpad.exe /app/release/promptpad.exe
# the container runs as root: give the lockfile back to the invoking user
docker run --rm -v "$PWD":/app promptpad-win chown "$(id -u):$(id -g)" /app/src-tauri/Cargo.lock
ls -la release/promptpad.exe
