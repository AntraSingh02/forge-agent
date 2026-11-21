# TrueFoundry Forge-a-thon: Technical Write-Up
**Team:** Forge Team  
**Extension:** Forge Agent (TrueForge-Native VS Code Copilot)  
**Target Benchmark:** `pallets/flask` (commit `22d92470`)

---

## 1. Team
- **Member:** Anuj Das
- **Role:** Full-Stack & Systems Developer
- **GitHub:** [@anxj-xe](https://github.com/anxj-xe)
- **Institution:** Techfest 2026-27 Participant, IIT Bombay

---

## 2. Starting Point
- **Starting Point:** Built **from scratch**.
- **Design Philosophy:** Rather than inheriting legacy complexity from existing open-source copilot extensions (which often tightly couple custom prompt loops to specific providers), Forge Agent was designed from day one around **TrueForge** as the central agent harness.
- **Upstream Harness:** Built against `@truefoundry/trueforge@latest` running locally on port 8790.
- **Repository:** Public at [https://github.com/anxj-xe/forge-agent.git](https://github.com/anxj-xe/forge-agent.git).

---

## 3. Architecture on TrueForge
Forge Agent follows a decoupled client-harness architecture:
- **Client Tier (VS Code Extension):**
  - Manages editor UI interactions: Inline Edit (`Ctrl+K`), the Webview Sidebar Panel, CodeLens decorations, and diff review.
  - Exposes an embedded **MCP Bridge Server** on `http://127.0.0.1:8792` exposing standard tools: `read_file`, `search_workspace`, `propose_edit`, and `run_terminal_command`.
- **Harness Tier (TrueForge on `localhost:8790`):**
  - Extension initiates sessions via `POST /api/v1/sessions` and drives turns via `POST /api/v1/sessions/:id/turns`.
  - Streams tokens back to the editor in real-time over Server-Sent Events (SSE).
  - Handles turn cancellation via `POST /api/v1/sessions/:id/turns/:turnId/cancel`.
- **Harness Features Utilized:**
  - **Context Compaction:** Enabled in the agent manifest (`compaction: { enabled: true }`) to compress long-running agent trajectories and prevent context overflow.
  - **Large Tool Response Truncation:** Enabled (`large_tool_response: { enabled: true }`) to safeguard against voluminous workspace file scans.
  - **Dynamic Subagents:** Configured for modular task execution.

---

## 4. How Context is Selected
Context assembly is managed by `ContextEngine` under a strict **16 KB budget**:
1. **Explicit Tag Resolution:**
   - Detects `@file:<path>` or `@<path>` and extracts targeted file contents into the context window.
   - Detects `@symbol:<name>` or `@#<name>` and queries VS Code's Workspace Symbol Provider to extract only the enclosing function/class definition rather than entire files.
2. **Autonomous Relevance Ranking:**
   - For unprompted tasks (such as Task B), the engine extracts high-signal keywords from the user prompt.
   - Ranks candidate workspace files using a weighted heuristic combining path matches and content keyword density across `src/`, `tests/`, and `docs/`.
   - The top candidate files are truncated to budget and injected with explicit selection reasoning.
3. **Visibility & Inspection:**
   - Every assembled context payload displays a budget summary log in the UI (e.g. `Budget: 16 KB | Used: 11 KB | Files: 3`), showing the exact files selected and reasons why.

---

## 5. Model Setup
- **Primary Model:** `google-gemini/gemini-3-5-flash-lite` configured in TrueForge.
- **Fallback Model:** `google-gemini/gemini-3-5-flash` configured in TrueForge.
- **Hosting / Endpoint:** Served via Google AI Studio through TrueForge's model provider catalog on `http://localhost:8790`.
- **Approximate Cost:** $0.00 (within Google AI Studio Free Tier).
- **Model Switching & Failover:**
  - Users can configure any catalog model or OpenAI-compatible endpoint in TrueForge's Settings UI or update `agents/forge-coding-agent.json`.
  - Extension features `ResilienceManager`: if the primary model returns an authentication error (401/403), connection timeout, or unreachable endpoint, the client automatically switches to `forge-coding-agent-fallback` with zero user intervention.

---

## 6. Scorecard

| Criterion | Video Timestamp | One-Line Claim |
| :--- | :---: | :--- |
| **A1. Inline Edit** | `00:35` | `Ctrl+K` proposes diff with CodeLens accept/reject and side-by-side diff review. |
| **A2. Agent Mode** | `01:40` | Autonomous multi-file edit touching `cli.py`, `test_cli.py`, and `cli.rst` unprompted. |
| **A3. Streaming & Cancellation** | `02:25` | Real-time SSE streaming with immediate Stop button leaving workspace 100% clean. |
| **B1. Context Assembly** | `01:10` | 16 KB size budget with @file/@symbol resolution and ranked selection logged on screen. |
| **B2. Diff Safety** | `02:05` | Review buffers prevent silent writes; selective per-hunk patching and working undo stack. |
| **B3. Resilience** | `03:10` | Endpoint failure triggers automatic fallback model takeover with clean `git status`. |
| **B4. TrueForge Integration** | `01:50` | Direct session/turn management, SSE streaming, compaction, and embedded MCP bridge. |
| **C1. Demo Video** | `00:00 - 03:50` | Tasks A, B, and C shown in order with on-screen terminal verifications and session view. |
| **C2. Write-Up** | Document | 8 mandatory headings detailing architecture, context strategy, models, and limitations. |

---

## 7. Tools Used
- **Core Stack:** TypeScript 5.4, Node.js 20+, VS Code Extension API (`^1.85.0`), `esbuild`.
- **Libraries:** `@truefoundry/trueforge` agent harness, `diff` (jsdiff) for structured patch calculation.
- **AI Coding Assistants:** Google Antigravity & Gemini CLI used during extension scaffolding and debugging (declared per competition rules; costs no points).

---

## 8. Known Limitations & Future Roadmap
- **Limitations:**
  - The MCP Bridge currently communicates over local HTTP (`http://127.0.0.1:8792`); high-load concurrent queries occasionally experience port contention.
  - The context ranking heuristic relies on lexical and path analysis rather than dense embeddings due to local compute constraints.
- **What We Would Build With Another Month:**
  1. **Native stdio MCP Transport:** Migrate the embedded MCP server to stdio pipes to remove HTTP port bindings entirely.
  2. **Tree-Sitter Semantic Graph:** Incorporate Tree-Sitter AST parsing to perform call-graph context expansion (e.g. automatically pulling caller/callee signatures when editing a function).
  3. **Multi-Turn Interactive Diff Refinement:** Allow users to comment directly on a proposed diff hunk and request adjustments before accepting.
