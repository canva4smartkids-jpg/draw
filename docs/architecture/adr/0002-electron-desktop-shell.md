# 0002: Electron as the desktop shell

- Status: accepted
- Date: 2026-11-04

## Context

The editor's core product is rendering that is accurate and identical
everywhere. Tauri renders through system webviews: WebView2 (Chromium) on
Windows, WKWebView (WebKit) on macOS, WebKitGTK on Linux. That gives three
engines with different canvas/GPU behaviour, and Tauri's own documentation
warns that canvas and WebGL can silently fall onto slow paths on Linux. A
Chromium runtime for Tauri exists only as a community alpha. Electron bundles
one Chromium on every platform, and Playwright can drive it for end-to-end
tests on all three OSes. See proposal §2.1.

## Decision

Build the desktop application on Electron.

Only `apps/desktop/src/main` and `apps/desktop/src/preload` may import
`electron`. Everything else talks to a typed `DesktopApi`. This is enforced
by `npm run boundaries`.

Security defaults:
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
- a strict CSP;
- validated IPC;
- untrusted files parsed off the main process.

## Consequences

- Larger installers and memory footprint than Tauri.
- Regular Electron upgrades are needed to stay on supported Chromium
  versions.
- Because the core packages are shell-agnostic, the editor also runs in a
  plain browser for development and tests, and a future shell change would
  be confined to `apps/desktop`.
- **Revisit if:** an official, stable Chromium runtime ships for Tauri, or
  installer size becomes a measured adoption problem.
