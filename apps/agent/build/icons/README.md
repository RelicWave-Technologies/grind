# Tray icons

Placeholders only — these are blank PNGs sized correctly for the OS tray.

Before shipping to dogfood, replace with real artwork:

- `trayTemplate.png` — 16×16, grayscale, macOS template image (the system tints it)
- `trayTemplate@2x.png` — 32×32 retina version
- `tray.png` — 16×16 RGBA for Windows/Linux

Electron's `tray.ts` calls `setTemplateImage(true)` on the macOS image so it adapts to light/dark menubar automatically.
