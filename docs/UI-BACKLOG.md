# Atelier — OpenSwarm parity backlog

Scanned from the installed OpenSwarm app (2026-07-01): 54 features, ranked. OpenSwarm's canvas is a DOM world-container (CSS translate+scale) with absolutely-positioned cards — the same model Atelier uses.

**Built so far:** modular core (`window.Atelier`), pan/zoom, drag+resize cards, wheel-zoom, dock app-cards, customizable widgets (double-click → Metric/Status/Chart/Checklist/Clock, persisted), ⌘K command palette, themes (Clay/Slate/Forest) + layout persistence.

| Priority | Effort | Feature | What |
|---|---|---|---|
| high | M | Infinite pan + zoom canvas | Scrollable/zoomable board. Wheel pans, wheel+modifier (or pinch) zooms; zoom is clamped (Math.max(1,1.5*zoom) style clamps seen). Events openswarm:... |
| high | S | Fit-to-view | Button that frames all cards ('Heads up! This snaps everything back into view'; canvas-fit-to-view). |
| high | M | Card drag (move) | Cards drag by a handle; regions opt out. Uses framer-motion (drag, drag-handle, data-no-drag, drag-constraints-ref); emits card_dragged. |
| high | M | Card resize | Cards resize from edges/corners (resize-handle; cursors ew/ns/nesw/nwse-resize seen). |
| high | M | Multiple dashboards (boards) | Many named boards: create/rename/duplicate/delete, auto name generation, reopen-last-closed, 'All dashboards' list with search and empty state ('Cr... |
| high | L | Agent / chat card | Core card type: a chat/agent unit that can spawn sub-agents; configurable default spawn state (expanded vs collapsed) and auto-reveal of sub-agents... |
| high | M | Note card (markdown editor) | Editable note card ('Add note', note-card, note_added) with full GFM markdown incl. footnotes; backed by a CodeMirror editor (306.bundle.js: cm-lin... |
| high | M | Command palette / picker (⌘K) | Cmd/Ctrl+K fuzzy picker over apps, cards, dashboards, models, and past chats ('Search apps...', 'Search cards...', 'Search dashboards...', 'Search ... |
| high | S | Add-App launcher (⌘M) | 'Add App ⌘M' toolbar button + menu to drop a new card onto the board (Browser/Note/etc.; data-onboarding=dashboard-toolbar-apps). |
| high | S | Themes / appearance | Light/Dark theme selector ('Application color scheme.', theme values light/dark, MUI palette-* tokens throughout). |
| high | M | Persistence / autosave | Board layouts + card state persisted (dashboardLayout/save+fetch, redux-persist 'persist:openswarm-browser', schema migrations openswarm.migrations... |
| high | S | Keyboard shortcuts | App-wide shortcuts: ⌘K palette, ⌘M add-app, a configurable new-agent shortcut, Esc to cancel marquee, plus browser/reload shortcuts (onBrowserShort... |
| high | L | Embedded browser cards / <webview> agent browsers | Multi-instance in-app browser tiles the agent drives. main.js createWindow enables webviewTag; will-attach-webview forces webview-preload.js on eve... |
| high | S | In-process frontend static server | startFrontendServer() runs a tiny Node http server serving the built React bundle from resources/frontend on a deterministic 127.0.0.1:4173 (falls ... |
| high | M | Python backend sidecar lifecycle | main.js spawns the bundled FastAPI backend as a child process: getPythonPath()/uv-bin resolves the bundled python-env, pickBackendPort() get-port w... |
| high | L | Workflows + cron scheduling engine | backend/apps/workflows: a single-task in-process cron scheduler (scheduler.py) with minute/hour/day/week/month units, IANA-timezone/DST-correct wal... |
| high | M | Settings + secure credentials | backend/apps/settings: settings.py + store.py persistence, credentials.py for provider API keys/secrets, and redaction.py that scrubs secrets from ... |
| high | M | Deep links + OAuth capture + provider connect | Custom openswarm:// scheme handling: onAuthUrl (Stripe-hosted checkout returns openswarm://auth?token=), onOauthClaim (openswarm://oauth/{provider}... |
| high | L | App Builder (outputs) — build/run/preview/publish | backend/apps/outputs: the agent scaffolds a real webapp (webapp_template = Vite frontend), and AppRuntime (runtime.py + runtime_proc.py) manages a ... |
| high | M | MCP registry + bundled MCP servers | backend/apps/mcp_registry (mcp_registry.py) manages MCP server config/enablement, with /api/mcp-meta/{action} and register_builtin_mcp_servers. Shi... |
| med | M | Minimap (toggle) | Toggleable overview minimap ('Pop on a minimap whenever things get crowded'; canvas-minimap-toggle, 'Hide minimap'/'Show minimap', persisted key op... |
| med | M | Tidy / auto-arrange layout | Auto-arranges cards into a clean grid ('And this auto tidies your layout'; canvas-tidy-layout; also 'Tidying duplicates'). |
| med | M | Marquee / rubber-band multi-select | Drag empty canvas to box-select cards; Esc cancels (dashboard-marquee-active body class, dashboard-marquee-style injected stylesheet). |
| med | L | Custom App / View cards (App Builder) | 'Make an App ⌘'-style builder: describe an app (tracker/viewer/game) in natural language -> generated reusable app rendered as a view-card; Apps hu... |
| med | S | Sidebar navigation | Left rail with Apps, Dashboards, Modes, Skills, Customization, Actions, Settings (sidebar-apps/-dashboards/-modes/-skills/-customization/-actions/-... |
| med | M | Settings panel | Settings with API-keys tab, Models tab, external subscriptions, Pro section, restart-tour, configurable new-agent keyboard shortcut, default browse... |
| med | S | Sharing: share link + .swarm export/import | 'Create share link', 'Download .swarm file' ('Save a file you can send to anyone.'), IosShare, and import ('openswarm:import-open', 'ImportDigest',... |
| med | M | Output version history / time-travel | Versioning of card outputs: capture/branch/fetch/restore (outputs/versions/capture/branch/fetch/restore, 'Could not restore that version.', 'Saved ... |
| med | L | CDP debugger attach + shadow-API route capture | main.js attaches a Chrome DevTools Protocol debugger to each browser webContents (ensureDebuggerAttached, send-cdp-command serialized, child-sessio... |
| med | M | Workflow OS-lifecycle glue (power/updater/quit/notify) | workflowsLifecycle.js keeps scheduled runs alive across real OS states: polls /api/workflows/active every 5s, holds a powerSaveBlocker while any ru... |
| med | M | Crash recovery (watchdog + window recreate) | Two layers. crash-watchdog.js: a detached macOS-only process that polls the parent PID and relaunches the .app via `open -n` on unexpected death, g... |
| med | M | Auto-updater | setupAutoUpdater() via electron-updater against GitHub (app-update.yml: openswarm-ai/openswarm), with check/download/install IPC, download-progress... |
| med | S | Splash / boot window | createSplashWindow shows splash.html (data-URL loaded, own preview.js) immediately while the backend spawns; main hides the real window until React... |
| med | M | Analytics / telemetry service | backend/apps/service (service.py, buffer.py, ring_buffer.py, analytics/ with agent_bridge + frontend_bridge + client, ANALYTICS_OVERVIEW.md) buffer... |
| med | M | Runtime preflight environment checks | preflight.js runs once per app version at first launch: parallel checks (OS/arch/version, free resources, write permission, macOS security/quaranti... |
| med | M | Dashboards (dynamic, live) | backend/apps/dashboards + dashboard_layout: agent-generated dashboards with persisted layout, streamed live over ws/dashboard, routed at /dashboard... |
| med | L | 9Router — embedded LLM API gateway | A whole second embedded app under resources/router: a Next.js 16 standalone server (9router-app v0.3.60) + an obfuscated MITM HTTPS proxy (mitm/ser... |
| med | S | Factory reset / clear-data controls | IPC hard-reset (hardReset) wipes the entire data dir and relaunches; browser:clear-data clears cookies/cache/localStorage for the browser-card part... |
| low | M | Dashboard thumbnails | Each board shows a live thumbnail preview (html2canvas capture; dashboards/updateThumbnail, 'Dashboard thumbnail capture failed'). |
| low | L | Browser card + browser agent | Built-in web browser card (address bar 'Search Google or enter URL...', bookmarks, homepage setting) that an agent can drive (BrowserNavigate/Click... |
| low | L | Terminal card | Terminal card (147.bundle.js 'Terminal', running/runtime states) for command execution / build output. |
| low | M | Calendar card | Calendar app card (CalendarMonthRounded/CalendarTodayRounded/EventNoteRounded icons; 'Checked the calendar'). |
| low | L | Workflow cards (card + hub + monitor) | Three related card types: a Workflow card, a Workflows hub card, and a Workflows monitor card. A chat can be 'saved as a workflow'; steps add/edit/... |
| low | L | Canvas-native agent orchestration (link/helper) | Spatial wiring: draw a box around a browser to link it to a chat ('Drag a box around the browser to link it'); draw a box around an older chat to m... |
| low | L | Skills / Modes / Tools-Actions-MCP customization | Extensibility surfaces: install/build Skills ('Install a skill', skill builder), Modes ('customize modes', auto-select mode on new agent), and Tool... |
| low | M | Multi-provider model picker | Model selector across providers (anthropic, openai, gemini, openrouter, cohere, xai, mistral, deepseek; brand colors + recent-models list openswarm... |
| low | S | Chat / card history + search | Searchable history of past chats/cards ('Search past chats...', agents/fetchHistory, agents/searchHistory, 'No chat history yet'). |
| low | L | Scheduling / cron for workflows | Schedule workflows to run (openswarm-schedule, pause/resume/cancel, 'Nothing scheduled in the next 7 days.', 'Pause all scheduled workflows'). |
| low | M | Onboarding tour | Scripted guided tour driven by data-onboarding-* anchors on real UI elements; steps use move_to/popup/delay/click kinds narrating each feature (can... |
| low | S | Affiliate / referral install tracking | affiliateTracking.js: on first launch generates an app_install_id, opens openswarm.com/welcome?app_install_id=… in the default browser, and polls a... |
| low | S | Terminal (App Builder log tab) | Not a general interactive shell — the 'Terminal' tab streams the App Builder runtime's stdout/stderr. runtime_proc.py keeps a 2000-line LOG_BUFFER ... |
| low | S | Calendar (workflow schedule view) | Not a standalone calendar app — it's the calendar rendering of scheduled workflows. The frontend sidebar has a Calendar entry (goCalendar → view 'c... |
| low | S | Wiki / knowledge base | Not present. No wiki/knowledge-base/docs feature exists in the shell or backend (grep for 'wiki' hits only agents/tools/web.py's Wikipedia web tool... |
| low | S | Native macOS mouse clamp module | resources/mouseclamp (native/mouseclamp, built via scripts/build-mouseclamp.sh, VMP-signed) installed by installMacMouseClamp() in main.js — a nati... |