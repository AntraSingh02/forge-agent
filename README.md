# Forge Agent: TrueForge-Native VS Code Coding Copilot

> Built for the **TrueFoundry Forge-a-thon (Techfest 2026-27, IIT Bombay)**.
> Fully compliant with all 5 core capabilities, 3 fixed benchmark tasks, and scoring anchors.

---

## Architecture Overview

```
 ┌─────────────────────────────────────────────────────────┐
 │               VS Code Extension (Client)                │
 │  ┌─────────────────┐  ┌──────────────────────────────┐  │
 │  │   Inline Edit   │  │   Autonomous Agent Panel     │  │
 │  │ (Ctrl+K Diffs)  │  │  (@file / @symbol Context)   │  │
 │  └────────┬────────┘  └──────────────┬───────────────┘  │
 │           │                          │                  │
 │           ▼                          ▼                  │
 │  ┌───────────────────────────────────────────────────┐  │
 │  │        Diff Manager & Hunk Review Engine          │  │
 │  │   (Per-hunk Accept/Reject · Working Undo Stack)   │  │
 │  └───────────────────────────────────────────────────┘  │
 └────────────────────────────┬────────────────────────────┘
                              │ REST (Sessions & Turns)
                              │ SSE (Streaming Tokens)
                              ▼
 ┌─────────────────────────────────────────────────────────┐
 │            TrueForge Agent Harness (Local)              │
 │                 http://localhost:8790                   │
 │                                                         │
 │  ┌───────────────────────┐   ┌───────────────────────┐  │
 │  │ Agent Execution Loop  │   │ Context & Compaction  │  │
 │  └───────────┬───────────┘   └───────────────────────┘  │
 └──────────────┼───────────────────────────▲──────────────┘
                │ Tool Calls                │ Model Calls
                ▼                           │
 ┌───────────────────────────┐  ┌───────────┴──────────────┐
 │    Embedded MCP Bridge    │  │    Bring-Your-Own-Model  │
 │   http://127.0.0.1:8792   │  │      (Google Gemini /    │
 │ (read_file, search, diff) │  │       Groq / Ollama)     │
 └───────────────────────────┘  └──────────────────────────┘
```

---

## 5 Mandatory Capabilities

1. **Inline Edit (`Ctrl+K`)**:
   - Highlight any code (e.g., `get_debug_flag` in `src/flask/helpers.py`), press `Ctrl+K`, enter natural language instructions.
   - Proposed diff is rendered directly in the editor with syntax-colored decorations (green added, red removed) and interactive CodeLenses.
   - Per-hunk **[Accept Hunk]** and **[Reject Hunk]** buttons. No silent writes to disk.

2. **Autonomous Agent Mode**:
   - A dedicated sidebar Webview panel (`Forge Agent`).
   - Give high-level tasks without naming files (e.g. *"Add built-in CLI command flask config with tests and documentation"*).
   - Agent discovers and edits **3+ files unprompted** (`cli.py`, `test_cli.py`, `cli.rst`).

3. **Context Assembly**:
   - Explicit `@file` and `@symbol` tag resolution.
   - Budget-capped (64 KB default) automated retrieval ranking candidate workspace files by relevance.
   - Context Engine visibly logs which files were selected, their size, and reasons why.

4. **Diff Safety & Full Undo**:
   - Every file change is held in review buffers until explicitly accepted hunk by hunk or via **[Accept All]**.
   - Working undo stack: click **[↺ Undo Last Change]** to restore disk state anytime.

5. **Streaming, Cancellation & Resilience**:
   - Real-time token streaming via Server-Sent Events (SSE).
   - Immediate **[■ Stop]** button interrupts generation cleanly mid-flight, leaving the workspace 100% consistent.
   - Automatic fallback to secondary configured model if primary provider endpoint is unreachable or key is invalid.

---

## Quickstart & Local Setup

### Prerequisites
- Node.js $\ge 20$ (`node -v`)
- Python $\ge 3.10$ (`python --version`)
- Visual Studio Code

### 1. Start TrueForge Locally
In a terminal, run:
```bash
npx @truefoundry/trueforge@latest
```
TrueForge starts in standalone mode on `http://localhost:8790`.

### 2. Configure Model Provider in TrueForge
1. Open [http://localhost:8790](http://localhost:8790) in your browser.
2. Navigate to **Settings** $\rightarrow$ **Model Providers**.
3. Select **Google Gemini** (or **OpenAI-compatible** / **Groq**).
4. Enter your API key and configure model: `google-gemini/gemini-3-5-flash`.
5. *(Optional for Resilience)* Configure a second fallback model provider.

### 3. Build & Install the Extension
```bash
cd forge-extension
npm install
npm run build
```

To run in development mode inside VS Code:
1. Open the `forge-extension` folder in VS Code.
2. Press **`F5`** to launch the **Extension Development Host**.
3. Open the benchmark repository (`pallets/flask` checked out to commit `22d92470`) in the new window.

---

## Rehearsal & Benchmark Tasks (`pallets/flask`)

### Task A: Inline Edit
1. Open `src/flask/helpers.py`.
2. Highlight function `get_debug_flag`.
3. Press `Ctrl+K` (or `Cmd+K` on Mac).
4. Type instruction:
   > *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
5. Review the proposed diff hunks in the editor and click **[✓ Accept Hunk]**.
6. Verify in terminal:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   **Output:** `False`

### Task B: Autonomous Agent Mode (Multi-File)
1. Open the **Forge Agent** sidebar panel.
2. Instruct without naming any files:
   > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."*
3. TrueForge searches the workspace, plans the change, and proposes edits touching $\ge 3$ files:
   - `src/flask/cli.py`
   - `tests/test_cli.py`
   - `docs/cli.rst`
4. Review hunks and click **Accept All**.
5. Verify in terminal:
   ```bash
   pytest tests/test_cli.py -q
   ```
   And run `flask config` to view the masked JSON output.

### Task C: Resilience
1. In TrueForge, temporarily invalidate the API key or set an unreachable endpoint.
2. Repeat Task A.
3. Observe:
   - The editor remains fully responsive.
   - Clean error notification is presented (or fallback model takes over automatically).
   - Running `git status` confirms zero dirty or half-applied files.

---

## License & Attribution

- Open-source licensed under the **MIT License**.
- Built upon the **TrueForge Agent Harness** (`@truefoundry/trueforge`).
- Diff calculation powered by `diff` (jsdiff).
