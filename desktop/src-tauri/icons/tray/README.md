# Tray status icons

Three states the tray exposes:

| File | State | Trigger |
|---|---|---|
| `idle-{32,64}.png` | nothing happening | default |
| `working-{32,64}.png` | indexing / replaying / remediating | sensor publishes `Busy` event (Sessions 5-10) |
| `alert-pending-{32,64}.png` | unread critical alert | cloud poller / capture ingest (Sessions 4, 10) |

Session 2 ships duplicates of the existing app icon as placeholders so
the file layout exists. Session 5+ should replace these with proper
monochrome variants (template-image friendly on macOS — pure black on
transparent so the OS can re-tint for dark/light menu bars).

The tray icon swap logic itself lands in Session 5 as part of the
sensor-state observer that reacts to `DaemonEvent::Heartbeat` plus
sensor-published variants.
