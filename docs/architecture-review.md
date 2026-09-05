# Architecture Review

- Nodes: 28
- Edges: 35
- Errors: 0
- Warnings: 39

## Findings

- **WARNING · production-has-observability · wa-clients** — production component WhatsApp MD Network
(Mobile, Desktop, Groups) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · web-dashboard** — production component Admin Web GUI
(Status, QR & Pairing Code) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · webhook-client** — production component External Webhook Caller
(Metrics & Alert Services) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · process-mgr** — production component Process Supervisor
(PM2 / Docker / OS Signals) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · express-server** — production component Express HTTP Server
(:8000 / Webhook / Health) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · schedulers** — production component Scheduler & Watchdog Engine
(GC, Sleep, Watchdog, Pruner) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · plugin-watcher** — production component Plugin Hot-Reloader
(FS Watcher & Dynamic Loader) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · baileys-socket** — production component Baileys WASocket Engine
(makeWASocket & Reconnect) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · socket-helpers** — production component Socket Helpers Extender
(Media, Buttons, Quoted) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · event-dispatcher** — production component Socket Event Dispatcher
(messages, creds, contacts, groups) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · msg-serializer** — production component Message Serializer
(Unwrap Ephemeral, Quoted & Media) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · security-gate** — production component Security & Mode Gatekeeper
(Ban Check, BotMode, Mod Auth) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · antidelete-engine** — production component Anti-Delete Engine
(Revocation Sniffer & Forwarder) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · command-router** — production component Command Router & Parser
(Prefix Matcher, Aliases & Registry) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · ai-fallback** — production component AI Persona & Fallback Router
(Gemini / OpenAI Character Engine) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · plugins-core** — production component Core Commands Plugin
(alive, menu, ping, restart, eval) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · plugins-group** — production component Group Admin & Moderation
(kick, add, tagall, mute, antilink) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · plugins-download** — production component Media Downloaders
(YT, IG, TikTok, FB, Twitter/X) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · plugins-github** — production component GitHub Projects & Issues
(Octokit REST & GraphQL Sync) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · plugins-tools** — production component Search & Media Tools
(Stickers, Lyrics, QR, Utilities) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · mongo-auth** — production component MongoAuth State Store
(Encrypted Multi-Device Credentials) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · mongodb-core** — production component Atlas Core MongoDB
(Users, Groups, Economy & Configs) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · baileys-store** — production component In-Memory Baileys Store
(Chats, Contacts & Message Buffer) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · antidelete-cache** — production component Message Revocation Cache
(TTL-Expiring Message Buffer) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · ext-gemini** — production component Google Gemini AI API
(Gemini 2.5 / Flash LLM) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · ext-openai-claude** — production component OpenAI & Anthropic APIs
(GPT-4o & Claude Fallbacks) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · ext-github-api** — production component GitHub Platform API
(REST v3 & GraphQL v4) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · production-has-observability · ext-scrapers** — production component Media Scrapers & CDNs
(YouTube, IG, TT, Lyrics) has no observability metadata
  - Suggested action: set properties.observability or add monitoring
- **WARNING · external-dependencies-have-timeouts · e-ai-gemini** — external call to Google Gemini AI API
(Gemini 2.5 / Flash LLM) has no timeout
  - Suggested action: set edge properties.timeout
- **WARNING · external-dependencies-have-timeouts · e-ai-openai** — external call to OpenAI & Anthropic APIs
(GPT-4o & Claude Fallbacks) has no timeout
  - Suggested action: set edge properties.timeout
- **WARNING · external-dependencies-have-timeouts · e-github-api** — external call to GitHub Platform API
(REST v3 & GraphQL v4) has no timeout
  - Suggested action: set edge properties.timeout
- **WARNING · external-dependencies-have-timeouts · e-download-scrapers** — external call to Media Scrapers & CDNs
(YouTube, IG, TT, Lyrics) has no timeout
  - Suggested action: set edge properties.timeout
- **WARNING · external-dependencies-have-timeouts · e-tools-scrapers** — external call to Media Scrapers & CDNs
(YouTube, IG, TT, Lyrics) has no timeout
  - Suggested action: set edge properties.timeout
- **WARNING · single-point-of-failure · ai-fallback** — AI Persona & Fallback Router
(Gemini / OpenAI Character Engine) connects otherwise separated parts of the system
  - Suggested action: add redundancy or an alternate path
- **WARNING · single-point-of-failure · baileys-socket** — Baileys WASocket Engine
(makeWASocket & Reconnect) connects otherwise separated parts of the system
  - Suggested action: add redundancy or an alternate path
- **WARNING · single-point-of-failure · command-router** — Command Router & Parser
(Prefix Matcher, Aliases & Registry) connects otherwise separated parts of the system
  - Suggested action: add redundancy or an alternate path
- **WARNING · single-point-of-failure · event-dispatcher** — Socket Event Dispatcher
(messages, creds, contacts, groups) connects otherwise separated parts of the system
  - Suggested action: add redundancy or an alternate path
- **WARNING · single-point-of-failure · express-server** — Express HTTP Server
(:8000 / Webhook / Health) connects otherwise separated parts of the system
  - Suggested action: add redundancy or an alternate path
- **WARNING · single-point-of-failure · plugins-github** — GitHub Projects & Issues
(Octokit REST & GraphQL Sync) connects otherwise separated parts of the system
  - Suggested action: add redundancy or an alternate path
- **INFO · high-coupling · command-router** — Command Router & Parser
(Prefix Matcher, Aliases & Registry) has 7 connections
  - Suggested action: verify the component is intentionally a hub
- **INFO · long-synchronous-chain · event-dispatcher -> msg-serializer -> security-gate -> command-router -> plugins-core -> mongodb-core** — synchronous path spans 6 components
  - Suggested action: verify latency budget, timeouts, and whether an asynchronous boundary is appropriate
- **INFO · long-synchronous-chain · event-dispatcher -> msg-serializer -> security-gate -> command-router -> plugins-core -> socket-helpers** — synchronous path spans 6 components
  - Suggested action: verify latency budget, timeouts, and whether an asynchronous boundary is appropriate
- **INFO · long-synchronous-chain · event-dispatcher -> msg-serializer -> security-gate -> command-router -> plugins-download -> ext-scrapers** — synchronous path spans 6 components
  - Suggested action: verify latency budget, timeouts, and whether an asynchronous boundary is appropriate
- **INFO · long-synchronous-chain · event-dispatcher -> msg-serializer -> security-gate -> command-router -> plugins-github -> ext-github-api** — synchronous path spans 6 components
  - Suggested action: verify latency budget, timeouts, and whether an asynchronous boundary is appropriate
- **INFO · long-synchronous-chain · event-dispatcher -> msg-serializer -> security-gate -> command-router -> plugins-group -> mongodb-core** — synchronous path spans 6 components
  - Suggested action: verify latency budget, timeouts, and whether an asynchronous boundary is appropriate
