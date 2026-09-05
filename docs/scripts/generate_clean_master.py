#!/usr/bin/env python3
"""
Atlas-MD Clean Architecture Diagram Builder
Generates a 100% clean, professional .drawio file:
- NO unwanted HTML tags or escape artifacts in values
- Multi-line text using clean standard newlines
- Logical 2-row layout where Persistence sits directly beneath processing
- Zero lines cutting across intermediate containers
- Proper orthogonal edge routing with distinct colors
"""

import xml.etree.ElementTree as ET
import xml.dom.minidom as minidom

def build_clean_architecture(output_path="architecture.drawio"):
    # Style presets
    font_base = "fontFamily=Helvetica;fontSize=11;"
    
    # Header colors
    c_ingress_hdr = "#1e293b"
    c_ingress_fill = "#f8fafc"
    c_ingress_border = "#94a3b8"

    c_core_hdr = "#1e40af"
    c_core_fill = "#f0f7ff"
    c_core_border = "#93c5fd"

    c_pipe_hdr = "#b45309"
    c_pipe_fill = "#fffdf5"
    c_pipe_border = "#fcd34d"

    c_plugin_hdr = "#6b21a8"
    c_plugin_fill = "#faf5ff"
    c_plugin_border = "#d8b4fe"

    c_ext_hdr = "#c2410c"
    c_ext_fill = "#fffaf5"
    c_ext_border = "#fdba74"

    c_persist_hdr = "#166534"
    c_persist_fill = "#f0fdf4"
    c_persist_border = "#86efac"

    def swimlane_style(hdr_col, fill_col, border_col):
        return (f"swimlane;startSize=32;fontFamily=Helvetica;fontSize=12;fontStyle=1;"
                f"strokeColor={border_col};fillColor={hdr_col};fontColor=#ffffff;"
                f"strokeWidth=2;swimlaneFillColor={fill_col};rounded=1;shadow=1;container=1;collapsible=0;")

    # Box styles (plain, clean, rounded, no HTML requirement)
    style_client = "rounded=1;whiteSpace=wrap;html=0;fillColor=#f1f5f9;strokeColor=#94a3b8;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"
    style_ingress = "rounded=1;whiteSpace=wrap;html=0;fillColor=#e0f2fe;strokeColor=#38bdf8;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"
    style_core = "rounded=1;whiteSpace=wrap;html=0;fillColor=#dbeafe;strokeColor=#60a5fa;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"
    style_pipe = "rounded=1;whiteSpace=wrap;html=0;fillColor=#fef3c7;strokeColor=#f59e0b;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"
    style_plugin = "rounded=1;whiteSpace=wrap;html=0;fillColor=#f3e8ff;strokeColor=#c084fc;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"
    style_ext = "rounded=1;whiteSpace=wrap;html=0;dashed=1;fillColor=#ffedd5;strokeColor=#fb923c;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"
    style_db = "shape=cylinder3;whiteSpace=wrap;html=0;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#dcfce7;strokeColor=#4ade80;strokeWidth=1.5;fontFamily=Helvetica;fontSize=11;fontStyle=0;shadow=1;align=center;verticalAlign=middle;"

    def edge_style(color="#64748b", dashed=False):
        d = "dashed=1;" if dashed else ""
        return (f"edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=0;"
                f"strokeColor={color};strokeWidth=1.5;{d}fontFamily=Helvetica;fontSize=10;fontColor=#334155;endArrow=classic;endFill=1;")

    # XML document setup
    mxfile = ET.Element("mxfile", host="drawio", version="26.0.0")
    diagram = ET.SubElement(mxfile, "diagram", name="Atlas-MD Architecture", id="atlas-arch-v4")
    model = ET.SubElement(diagram, "mxGraphModel", dx="1800", dy="1200", grid="1", gridSize="10",
                          guides="1", tooltips="1", connect="1", arrows="1", fold="1", page="1",
                          pageScale="1", pageWidth="1860", pageHeight="1120", background="#f8fafc")
    root = ET.SubElement(model, "root")

    # Required base cells
    ET.SubElement(root, "mxCell", id="0")
    ET.SubElement(root, "mxCell", id="1", parent="0")

    # Top Title Banner (pure clean string, NO tags!)
    title_text = "Atlas-MD v4.1.0 — System Architecture & Component Topology\nModular WhatsApp Multi-Device Automation Bot • Express Web Dashboard • Dynamic Plugin Engine • AI Persona Integration"
    title_cell = ET.SubElement(root, "mxCell", id="title_banner",
                               value=title_text,
                               style="text;html=0;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=1;fillColor=#ffffff;strokeColor=#cbd5e1;strokeWidth=1.5;spacingLeft=16;shadow=1;fontFamily=Helvetica;fontSize=12;fontStyle=1;fontColor=#1e293b;",
                               vertex="1", parent="1")
    ET.SubElement(title_cell, "mxGeometry", x="40", y="20", width="1770", height="50", **{"as": "geometry"})

    # Containers definition: (id, title, x, y, w, h, style)
    containers = [
        ("c_clients", "1. Clients & Ingress Triggers", 40, 90, 260, 480, swimlane_style(c_ingress_hdr, c_ingress_fill, c_ingress_border)),
        ("c_core", "2. Ingress & Core Connection", 330, 90, 290, 480, swimlane_style(c_core_hdr, c_core_fill, c_core_border)),
        ("c_pipeline", "3. Message Pipeline & Security", 650, 90, 330, 480, swimlane_style(c_pipe_hdr, c_pipe_fill, c_pipe_border)),
        ("c_plugins", "4. Modular Plugin Subsystems", 1010, 90, 380, 480, swimlane_style(c_plugin_hdr, c_plugin_fill, c_plugin_border)),
        ("c_external", "5. External AI & Cloud APIs", 1420, 90, 390, 480, swimlane_style(c_ext_hdr, c_ext_fill, c_ext_border)),
        ("c_persist", "6. Persistence & State Storage Tier (Shared Foundation)", 330, 600, 1480, 480, swimlane_style(c_persist_hdr, c_persist_fill, c_persist_border)),
    ]

    for cid, name, x, y, w, h, style in containers:
        c_cell = ET.SubElement(root, "mxCell", id=cid, value=name, style=style, vertex="1", parent="1")
        ET.SubElement(c_cell, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h), **{"as": "geometry"})

    # Nodes: (id, parent, clean_text_label, x, y, w, h, style)
    nodes = [
        # Container 1: Clients & Ingress
        ("wa_client", "c_clients", "WhatsApp MD Network\n[Users, Groups & Channels]\nMulti-Device Encrypted WSS", 20, 50, 220, 75, style_client),
        ("web_gui", "c_clients", "Admin Web Dashboard\n[Browser HTML/CSS GUI]\nLive Status & QR Viewer", 20, 155, 220, 75, style_client),
        ("webhook_caller", "c_clients", "External Webhook Caller\n[Metrics & Alert Services]\nBearer Secret Auth Header", 20, 260, 220, 75, style_client),
        ("process_mgr", "c_clients", "Process Supervisor\n[PM2 / Docker / OS Signals]\nHeap Limit Cap & atlas.pid", 20, 365, 220, 75, style_client),

        # Container 2: Ingress & Core Connection
        ("express_server", "c_core", "Express HTTP Server\n[:8000 / REST APIs]\nStatic UI, Pairing Code & Webhook", 20, 50, 250, 75, style_ingress),
        ("schedulers", "c_core", "Schedulers & Maintenance\n[Forced V8 GC & Sleep Mode]\nOff-Hours Auto Disconnect", 20, 155, 250, 75, style_core),
        ("watchdog", "c_core", "Connection Watchdog\n[Keepalive Ping & Stall Detector]\nAuto Failover & Health Probes", 20, 260, 250, 75, style_core),
        ("baileys_socket", "c_core", "Baileys WASocket Engine\n[Multi-Device Protocol Engine]\nGeneration Tracking & Reconnect", 20, 365, 250, 85, style_core),

        # Container 3: Message Pipeline & Security
        ("event_dispatcher", "c_pipeline", "Socket Event Dispatcher\n[messages.upsert, creds, contacts]\nCentral Event Distribution Hub", 20, 45, 290, 70, style_pipe),
        ("msg_serializer", "c_pipeline", "Message Serializer\n[whatsapp.ts Normalization]\nUnrolls Ephemeral, Quoted & Media", 20, 130, 290, 70, style_pipe),
        ("security_gate", "c_pipeline", "Security & Mode Gatekeeper\n[Ban Checks & Bot Mode Public/Private]\nMod / Maintainer Verification", 20, 215, 290, 70, style_pipe),
        ("command_router", "c_pipeline", "Command Router & Tokenizer\n[ReadCommands & Prefix Matcher]\nAlias Resolution & Permission Flags", 20, 300, 290, 75, style_pipe),
        ("ai_router", "c_pipeline", "AI Chatbot & Persona Router\n[System Prompts & BotCharacters.js]\nConversational Character Engine", 20, 390, 290, 75, style_pipe),

        # Container 4: Modular Plugin Subsystems (2 neat columns)
        ("plugin_core", "c_plugins", "Core Commands\nalive, ping, system,\nrestart, eval, shell", 20, 50, 160, 85, style_plugin),
        ("plugin_group", "c_plugins", "Group Admin Suite\nkick, add, promote,\ntagall, mute, antilink", 20, 155, 160, 85, style_plugin),
        ("plugin_mod", "c_plugins", "Moderator Suite\nban, unban, warn,\nresetwarn, modlist", 20, 260, 160, 85, style_plugin),
        ("plugin_tools", "c_plugins", "Search & Tools\nlyrics, search, QR,\nsticker maker, ffmpeg", 20, 365, 160, 85, style_plugin),

        ("plugin_download", "c_plugins", "Media Downloader\nYouTube, Instagram,\nTikTok, Facebook, X", 200, 50, 160, 85, style_plugin),
        ("plugin_github", "c_plugins", "GitHub Projects Hub\nOctokit REST & GraphQL\nIssues & Board Sync", 200, 155, 160, 85, style_plugin),
        ("plugin_custom", "c_plugins", "Specialized Plugins\ndaily-wins, jimmy,\nrevive, dynamic loader", 200, 260, 160, 85, style_plugin),
        ("socket_helpers", "c_plugins", "Socket Helpers Decorator\nsendButtons, sendImage,\noutbound dispatcher", 200, 365, 160, 85, style_plugin),

        # Container 5: External AI & Cloud APIs
        ("ext_gemini", "c_external", "Google Gemini AI API\n[@google/genai SDK • Gemini 2.5 Flash]\nCore Conversational Reasoning & Personas", 25, 50, 340, 70, style_ext),
        ("ext_openai", "c_external", "OpenAI & Anthropic APIs\n[GPT-4o & Claude 3.5 Sonnet]\nMulti-Model Resilience Fallback", 25, 135, 340, 70, style_ext),
        ("ext_github", "c_external", "GitHub Platform API\n[REST v3 & GraphQL v4 Endpoints]\nRepository Issues & Project Automation", 25, 220, 340, 70, style_ext),
        ("ext_scrapers", "c_external", "Media Scraping Services\n[RapidAPI, Cheerio, Video CDN Parsers]\nSocial Media Stream Extraction", 25, 305, 340, 70, style_ext),
        ("ext_services", "c_external", "Search & Metadata Services\n[youtube-yts & lyrics-scraper]\nTrack Metadata & Search Results", 25, 390, 340, 70, style_ext),

        # Container 6: Persistence & State Storage Tier (Directly underneath)
        ("mongo_auth", "c_persist", "MongoAuth State Store\n[Cloud Multi-Device Credentials]\nEncrypted Signal Keys, Pre-Keys & App State", 30, 50, 320, 100, style_db),
        ("mongo_core", "c_persist", "Atlas Core MongoDB (Mongoose ODM)\n[Central Relational Document Store]\nUsers (XP/Warnings), Groups & Bot Configuration", 380, 50, 340, 100, style_db),
        ("baileys_store", "c_persist", "In-Memory Baileys Store\n[Active Session Directory]\nContacts Directory, Chat History & Metadata", 750, 50, 330, 100, style_db),
        ("antidelete_cache", "c_persist", "Message Revocation Cache\n[TTL-Expiring In-Memory Vault]\nRecent Messages Buffer (MESSAGE_CACHE_TTL_MS)", 1110, 50, 340, 100, style_db),

        ("plugin_watcher", "c_persist", "Plugin Hot-Reload Watcher\n[fs.watch Dynamic ESM Loader]\nAuto-reloads Plugins without Socket Restarts", 30, 190, 320, 90, style_core),
        ("antilink_guard", "c_persist", "Antilink Protection Guard\n[Group Invite Link Detection]\nEnforces Ban & Warn Actions via MongoDB Policy", 380, 190, 340, 90, style_pipe),
        ("antidelete_engine", "c_persist", "Anti-Delete Engine\n[protocolMessage Revocation Sniffer]\nRecovers & Forwards Revoked Messages to Admin", 1110, 190, 340, 90, style_pipe),
    ]

    for nid, pid, val, x, y, w, h, style in nodes:
        node_cell = ET.SubElement(root, "mxCell", id=nid, value=val, style=style, vertex="1", parent=pid)
        ET.SubElement(node_cell, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h), **{"as": "geometry"})

    # Edges: Clean orthogonal lines without cutting across containers
    # (id, source, target, label, color, dashed, exitX, exitY, entryX, entryY)
    edges = [
        # Ingress flows (Left to Right into Col 2)
        ("e_wa_baileys", "wa_client", "baileys_socket", "WebSocket WSS Stream", "#0284c7", False, 1, 0.5, 0, 0.5),
        ("e_web_server", "web_gui", "express_server", "REST /api/status & /api/qr", "#0284c7", False, 1, 0.5, 0, 0.5),
        ("e_webhook_server", "webhook_caller", "express_server", "POST /api/webhook", "#0284c7", False, 1, 0.5, 0, 0.8),
        ("e_proc_server", "process_mgr", "schedulers", "Spawn & Schedule", "#475569", True, 1, 0.5, 0, 0.5),

        # Column 2 Internal Controls (Vertical)
        ("e_express_socket", "express_server", "baileys_socket", "Pairing & Webhook Msg", "#0284c7", False, 0.2, 1, 0.2, 0),
        ("e_sched_socket", "schedulers", "baileys_socket", "Sleep Disconnect & GC", "#2563eb", True, 0.5, 1, 0.5, 0),
        ("e_watchdog_socket", "watchdog", "baileys_socket", "Health Probe & Ping", "#2563eb", False, 0.8, 1, 0.8, 0),

        # Column 2 to Column 3 (Engine -> Pipeline Hub)
        ("e_socket_events", "baileys_socket", "event_dispatcher", "ev.emit events", "#2563eb", False, 1, 0.5, 0, 0.5),

        # Column 3 Pipeline Internal Flow (Vertical)
        ("e_events_serializer", "event_dispatcher", "msg_serializer", "messages.upsert", "#d97706", False, 0.5, 1, 0.5, 0),
        ("e_serializer_sec", "msg_serializer", "security_gate", "Normalized Context", "#d97706", False, 0.5, 1, 0.5, 0),
        ("e_sec_router", "security_gate", "command_router", "Authorized Cmd", "#d97706", False, 0.3, 1, 0.3, 0),
        ("e_sec_ai", "security_gate", "ai_router", "Chatbot / Non-Cmd", "#d97706", False, 0.7, 1, 0.7, 0),

        # Column 3 to Column 4 (Router -> Plugins Dispatch)
        ("e_router_core", "command_router", "plugin_core", "Dispatch Core", "#9333ea", False, 1, 0.2, 0, 0.5),
        ("e_router_group", "command_router", "plugin_group", "Dispatch Group", "#9333ea", False, 1, 0.4, 0, 0.5),
        ("e_router_mod", "command_router", "plugin_mod", "Dispatch Mod", "#9333ea", False, 1, 0.6, 0, 0.5),
        ("e_router_tools", "command_router", "plugin_tools", "Dispatch Tools", "#9333ea", False, 1, 0.8, 0, 0.5),
        ("e_router_dl", "command_router", "plugin_download", "Dispatch Downloader", "#9333ea", False, 1, 0.3, 0, 0.2),
        ("e_router_gh", "command_router", "plugin_github", "Dispatch GitHub", "#9333ea", False, 1, 0.5, 0, 0.2),

        # Column 4 & 3 to Column 5 (External Cloud & AI APIs)
        ("e_ai_gemini", "ai_router", "ext_gemini", "Gemini 2.5 Flash Reasoning", "#ea580c", False, 1, 0.3, 0, 0.5),
        ("e_ai_openai", "ai_router", "ext_openai", "Fallback LLM API", "#ea580c", True, 1, 0.7, 0, 0.5),
        ("e_gh_api", "plugin_github", "ext_github", "Octokit REST / GraphQL", "#ea580c", False, 1, 0.5, 0, 0.5),
        ("e_dl_scrapers", "plugin_download", "ext_scrapers", "Scrape Video / Audio", "#ea580c", False, 1, 0.5, 0, 0.5),
        ("e_tools_lyrics", "plugin_tools", "ext_services", "Query Lyrics & Track Info", "#ea580c", False, 1, 0.5, 0, 0.5),

        # Return / Outbound Path (Plugins / AI -> Socket Helpers -> Baileys Socket)
        ("e_plugin_reply", "plugin_core", "socket_helpers", "Send Reply", "#2563eb", False, 0.5, 1, 0.2, 0),
        ("e_ai_reply", "ai_router", "socket_helpers", "Send AI Message", "#2563eb", False, 1, 0.9, 0, 0.8),
        ("e_helpers_socket", "socket_helpers", "baileys_socket", "Transmit via WASocket", "#2563eb", False, 0, 0.5, 1, 0.8),

        # Downward Persistence Connections (Straight DOWN into Container 6!)
        ("e_events_auth", "event_dispatcher", "mongo_auth", "creds.update (saveCreds)", "#16a34a", False, 0.2, 1, 0.5, 0),
        ("e_sec_db", "security_gate", "mongo_core", "Check Ban & Mode", "#16a34a", False, 0.5, 1, 0.3, 0),
        ("e_group_db", "plugin_group", "mongo_core", "Update Group Config", "#16a34a", False, 0.5, 1, 0.7, 0),
        ("e_events_store", "event_dispatcher", "baileys_store", "contacts.update", "#16a34a", False, 0.8, 1, 0.5, 0),

        # Container 6 Internal Anti-Delete & Protection Connections
        ("e_events_antidelete", "event_dispatcher", "antidelete_engine", "messages.update", "#d97706", False, 0.9, 1, 0.2, 0),
        ("e_antidelete_cache", "antidelete_engine", "antidelete_cache", "Lookup Revoked Msg", "#16a34a", False, 0.5, 0, 0.5, 1),
        ("e_antilink_db", "antilink_guard", "mongo_core", "Enforce Antilink Policy", "#16a34a", False, 0.5, 0, 0.5, 1),
        ("e_watcher_router", "plugin_watcher", "command_router", "Hot Reload Plugins", "#9333ea", True, 0.5, 0, 0.1, 1),
    ]

    for item in edges:
        eid, src, tgt, label, col, dashed, ex, ey, enx, eny = item
        edge_style_str = edge_style(col, dashed) + f"exitX={ex};exitY={ey};entryX={enx};entryY={eny};"
        edge_cell = ET.SubElement(root, "mxCell", id=eid, value=label, style=edge_style_str, edge="1", parent="1", source=src, target=tgt)
        ET.SubElement(edge_cell, "mxGeometry", relative="1", **{"as": "geometry"})

    # Write out cleanly indented XML
    xml_bytes = ET.tostring(mxfile, encoding="utf-8")
    dom = minidom.parseString(xml_bytes)
    pretty_xml = dom.toprettyxml(indent="  ", encoding="utf-8").decode("utf-8")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(pretty_xml)

    print(f"Clean architecture diagram generated at: {output_path}")

if __name__ == "__main__":
    build_clean_architecture()
