# Changelog

## Unreleased

### Fixed

- The macOS build now produces the Intel disk image as well as the Apple Silicon one (1.1.0 shipped Apple Silicon only).

## 1.1.0 (2026-09-30)

Deploy the API (migration `0003`) before publishing this desktop version.

### Added

- **Application menu and shortcuts:** File, Edit, View, Window and Help menus; Ctrl+N new deal, Ctrl+1 calculator, Ctrl+2 lenders, Ctrl+B deal list, zoom and full screen. _Help → Keyboard Shortcuts_ lists them.
- **Remembered window:** size, position, maximised and full-screen state are restored on the next launch, only onto a screen that is still connected. Bounds are rounded to whole screen pixels so the window doesn't grow a little on every launch at 125% display scaling.
- **Whole-dollar repayments:** a custom fee signature can round the repayment up to the next dollar; the final instalment is reduced so the loan closes exactly, and commission is unchanged. It's off by default, so existing quotes don't change.
- **Automatic updates (Windows):** the installed app checks for a new version at start-up and every 6 hours, downloads it in the background and offers _Restart and update_; otherwise it installs when the app is next closed. 1.0.0 has no updater, so install 1.1.0 by hand once.
- **macOS build:** a disk image for Apple Silicon (ad-hoc signed, not notarised). The Intel image was not built for this release.
- **CI and releases:** GitHub Actions runs every check on each push and pull request; a version tag builds the installers and uploads them, with the update feed, to Cloud Storage. Downloads moved from GitHub Releases to Cloud Storage; the 1.0.0 GitHub release is unchanged.
- READMEs for each app, package and folder.

### Changed

- The deal's **Saved quotes** tab is now **Quote log**, with a **Table** / **Compare side by side** switch.
- Packaged builds no longer offer reload or developer tools (Electron's default menu did).
- The finance amount message now states the real limit: under $1 billion.

### Fixed

- Corrected the official fixture count in the README: 39 of the 49 expected values match (it said 41 of 46). Known limitations now goes through each of the five failing cases.

## 1.0.0

First release: Windows installer, Google sign-in, deals and quote logs, four commission models, lender library with custom fee signatures and logos, client email export, Cloud Run API with PostgreSQL row-level security.
