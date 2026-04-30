# Bundled fonts

Inari Live ships fonts offline so the dock and main windows render
correctly with no network. The `.woff2` payloads are NOT committed to the
repo (they are large enough that the Sesión 14 patch stays small);
download once, drop the files in this directory, and the desktop build
picks them up via the `@font-face` declarations in
`src/styles/globals.css`.

| File                              | Source                                                                                       | License |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| `Inter-Variable.woff2`            | https://fonts.google.com/share?selection.family=Inter:wght@100..900                          | OFL-1.1 |
| `JetBrainsMono-Variable.woff2`    | https://fonts.google.com/share?selection.family=JetBrains+Mono:wght@100..800                 | OFL-1.1 |
| `SourceSerif4-Variable.woff2`     | https://fonts.google.com/share?selection.family=Source+Serif+4:opsz,wght@8..60,200..900      | OFL-1.1 |

Total payload should land under 500 KB combined (variable axes already
collapse weight 100–900 into a single file per family).

If a build runs without the files present, the `@font-face` stack falls
through to the platform `system-ui` / `Georgia` / `ui-monospace` fonts —
visually acceptable but not the locked design.

If the firewall on your network blocks Google Fonts, mirror the files from
the official upstream repos:

- Inter — https://github.com/rsms/inter/releases (download `Inter-4.0.zip`, take `web/InterVariable.woff2`).
- JetBrains Mono — https://github.com/JetBrains/JetBrainsMono/releases (`JetBrainsMono-Variable.woff2`).
- Source Serif 4 — https://github.com/adobe-fonts/source-serif/releases (`SourceSerif4-VF.woff2`).

Rename to the paths above and commit only if the project's license review
allows OFL fonts in the binary distribution (it does — see § *License audit*
in INARI_LIVE_DECISIONS.md, Sesión 14).
