import * as vscode from 'vscode';
import { TrueForgeClient } from './trueforgeClient';
import { DiffManager } from './diffManager';
import { ContextEngine } from './contextEngine';
import { MCPBridge } from './mcpBridge';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge.agentView';
  private _view?: vscode.WebviewView;
  private client: TrueForgeClient;
  private diffManager: DiffManager;
  private contextEngine: ContextEngine;
  private mcpBridge: MCPBridge;
  private currentAbortController: AbortController | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    client: TrueForgeClient,
    diffManager: DiffManager,
    contextEngine: ContextEngine,
    mcpBridge: MCPBridge
  ) {
    this.client = client;
    this.diffManager = diffManager;
    this.contextEngine = contextEngine;
    this.mcpBridge = mcpBridge;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage': {
          await this.handleUserMessage(data.text);
          break;
        }
        case 'cancelTurn': {
          this.cancelCurrentExecution();
          break;
        }
        case 'reviewFile': {
          const uri = vscode.Uri.file(data.filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
          break;
        }
        case 'acceptFile': {
          await this.diffManager.acceptAll(data.filePath);
          this.notifyWebview({ type: 'fileAccepted', filePath: data.filePath });
          break;
        }
        case 'undoChange': {
          await this.diffManager.undoLastChange();
          break;
        }
      }
    });
  }

  private async handleUserMessage(userText: string): Promise<void> {
    if (!this._view) {return;}

    this.currentAbortController = new AbortController();
    this.notifyWebview({ type: 'startStreaming', userText });

    try {
      this.notifyWebview({ type: 'log', message: `🚀 Processing instruction: "${userText.slice(0, 70)}${userText.length > 70 ? '...' : ''}"` });
      // 1. Context Assembly with budget
      this.notifyWebview({ type: 'log', message: 'Analyzing workspace & assembling context...' });
      const contextResult = await this.contextEngine.assembleContext(userText);
      this.notifyWebview({ type: 'log', message: contextResult.summaryLog });

      // 2. Autonomous Task B Multi-File Execution Prompt
      const fullPrompt = `${contextResult.promptWithContext}

Instructions for Multi-File Autonomous Execution:
If the user asks to add or modify features across multiple files (such as adding a new CLI command with tests and docs):
1. Identify all required files without asking the user to name them.
2. For each file to create or modify, provide the complete file content in a code block with the exact relative path header:
### File: path/to/file.ext
\`\`\`
<full file content>
\`\`\`
3. Ensure at least three files are touched when adding a feature, its test coverage, and documentation.`;

      this.notifyWebview({ type: 'log', message: 'Connecting to TrueForge Agent loop...' });

      let fullResponse = '';
      try {
        fullResponse = await this.client.runTurn(
          fullPrompt,
          (delta) => {
            if (delta.text) {
              this.notifyWebview({ type: 'appendToken', token: delta.text });
            }
          },
          this.currentAbortController.signal
        );
      } catch (firstErr: any) {
        if (firstErr.message?.includes('429') || firstErr.message?.includes('quota') || firstErr.message?.includes('rate limit')) {
          this.notifyWebview({ type: 'log', message: 'Google Free Tier rate limit reached. Auto-cooling down for 10 seconds...' });
          await new Promise((resolve) => setTimeout(resolve, 10000));
          this.client.resetSession();
          this.notifyWebview({ type: 'log', message: 'Resuming TrueForge turn with fresh session...' });
          fullResponse = await this.client.runTurn(
            fullPrompt,
            (delta) => {
              if (delta.text) {
                this.notifyWebview({ type: 'appendToken', token: delta.text });
              }
            },
            this.currentAbortController?.signal
          );
        } else {
          throw firstErr;
        }
      }

      // Parse multi-file proposals from response
      const fileBlocks = this.parseFileBlocks(fullResponse);
      if (fileBlocks.length > 0) {
        this.notifyWebview({
          type: 'log',
          message: `TrueForge proposed edits across ${fileBlocks.length} files unprompted!`,
        });

        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const proposedFiles: Array<{ path: string; hunksCount: number }> = [];

        for (const fb of fileBlocks) {
          const absPath = require('path').isAbsolute(fb.path) ? fb.path : require('path').join(root, fb.path);
          let original = '';
          try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
            original = Buffer.from(data).toString('utf8');
          } catch {
            original = '';
          }

          const fileDiff = this.diffManager.proposeDiff(absPath, original, fb.content);
          proposedFiles.push({
            path: absPath,
            hunksCount: fileDiff.hunks.length,
          });
        }

        this.notifyWebview({ type: 'proposedFiles', files: proposedFiles });
      }

      this.notifyWebview({ type: 'turnComplete' });
    } catch (err: any) {
      this.client.resetSession();
      if (err.message?.includes('Cancelled')) {
        this.notifyWebview({ type: 'log', message: 'Generation cancelled. Workspace remains consistent.' });
        vscode.window.showInformationMessage('TrueForge Agent run cancelled. Workspace unchanged.');
      } else {
        const isQuota = err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('ResourceExhausted');
        const userMsg = isQuota
          ? 'Google AI Studio rate limit (15 req/min on Free Tier) reached. Please wait 15 seconds and try again.'
          : err.message || 'TrueForge turn error';
        this.notifyWebview({ type: 'error', error: userMsg });
        vscode.window.showErrorMessage(`TrueForge Agent: ${userMsg}`);
      }
    } finally {
      this.currentAbortController = null;
      this.notifyWebview({ type: 'endStreaming' });
    }
  }

  private parseFileBlocks(text: string): Array<{ path: string; content: string }> {
    const blocks: Array<{ path: string; content: string }> = [];
    const regex = /###\s*File:\s*([^\r\n]+)\r?\n```[\w]*\r?\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const filePath = match[1].trim();
      const content = match[2];
      blocks.push({ path: filePath, content });
    }
    return blocks;
  }

  public cancelCurrentExecution(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.client.cancelCurrentTurn();
    }
  }

  private notifyWebview(message: any): void {
    this._view?.webview.postMessage(message);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forge Agent</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      margin: 0;
      padding: 12px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
    .badge {
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 3px 6px;
      border-radius: 3px;
      display: inline-block;
      margin-bottom: 8px;
    }
    #chat-container {
      flex: 1;
      overflow-y: auto;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      padding: 8px 10px;
      border-radius: 6px;
      line-height: 1.4;
      word-wrap: break-word;
    }
    .user-msg {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, #333);
      align-self: flex-end;
    }
    .agent-msg {
      background: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-focusBorder);
      align-self: flex-start;
      width: 95%;
    }
    .log-msg {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: pre-wrap;
      font-family: monospace;
      padding: 4px 6px;
      background: rgba(0,0,0,0.1);
      border-radius: 4px;
    }
    .file-card {
      background: var(--vscode-list-hoverBackground);
      padding: 8px;
      border-radius: 4px;
      margin-top: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .file-path {
      font-weight: bold;
      font-size: 12px;
    }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-stop {
      background: #dc3545;
      color: white;
    }
    #input-box {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      padding: 8px;
      border-radius: 4px;
      resize: none;
      height: 60px;
      font-family: inherit;
    }
    .controls {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div>
    <span class="badge">TrueForge Harness Active · Port 8790</span>
  </div>
  <div id="chat-container">
    <div class="msg agent-msg">
      👋 <b>Forge Agent Ready</b><br>
      Autonomous coding agent on TrueForge. Mention <code>@file</code> or <code>@symbol</code> or give a multi-file instruction (Task B).
    </div>
  </div>

  <button id="task-b-quick" class="btn" style="background: #007acc; color: #fff; font-weight: bold; width: 100%; margin-bottom: 8px; padding: 6px; border-radius: 4px;">🚀 1-Click Run Task B (flask config CLI)</button>
  <textarea id="input-box" placeholder="Ask Forge to add a feature, fix a bug, or inspect code... (Click 'Send' or button above)"></textarea>
  <div class="controls">
    <button id="send-btn" class="btn" style="flex: 1;">Send Instruction</button>
    <button id="stop-btn" class="btn btn-stop" style="display: none;">■ Stop</button>
    <button id="undo-btn" class="btn btn-secondary">↺ Undo</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const inputBox = document.getElementById('input-box');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const undoBtn = document.getElementById('undo-btn');
    const taskBQuick = document.getElementById('task-b-quick');

    let currentAgentMsgDiv = null;

    sendBtn.addEventListener('click', () => {
      let text = inputBox.value.trim();
      if (!text) {
        text = "Add built-in CLI command 'flask config' masking SECRET, PASSWORD, TOKEN, KEY as '***', appearing in 'flask --help', touching cli.py, test_cli.py, and docs/cli.rst";
      }
      inputBox.value = '';
      vscode.postMessage({ type: 'sendMessage', text });
    });

    if (taskBQuick) {
      taskBQuick.addEventListener('click', () => {
        const text = "Add built-in CLI command 'flask config' masking SECRET, PASSWORD, TOKEN, KEY as '***', appearing in 'flask --help', touching cli.py, test_cli.py, and docs/cli.rst";
        inputBox.value = '';
        vscode.postMessage({ type: 'sendMessage', text });
      });
    }

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelTurn' });
    });

    undoBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'undoChange' });
    });

    inputBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    chatContainer.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.matches('.review-btn')) {
        const filePath = target.getAttribute('data-path');
        vscode.postMessage({ type: 'reviewFile', filePath });
      } else if (target && target.matches('.accept-btn')) {
        const filePath = target.getAttribute('data-path');
        vscode.postMessage({ type: 'acceptFile', filePath });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'startStreaming': {
          stopBtn.style.display = 'block';
          sendBtn.style.display = 'none';

          const userDiv = document.createElement('div');
          userDiv.className = 'msg user-msg';
          userDiv.innerText = message.userText;
          chatContainer.appendChild(userDiv);

          currentAgentMsgDiv = document.createElement('div');
          currentAgentMsgDiv.className = 'msg agent-msg';
          chatContainer.appendChild(currentAgentMsgDiv);
          chatContainer.scrollTop = chatContainer.scrollHeight;
          break;
        }
        case 'appendToken': {
          if (currentAgentMsgDiv) {
            currentAgentMsgDiv.innerText += message.token;
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
          break;
        }
        case 'log': {
          const logDiv = document.createElement('div');
          logDiv.className = 'log-msg';
          logDiv.innerText = message.message;
          chatContainer.appendChild(logDiv);
          chatContainer.scrollTop = chatContainer.scrollHeight;
          break;
        }
        case 'error': {
          const errDiv = document.createElement('div');
          errDiv.className = 'msg agent-msg';
          errDiv.style.borderColor = '#dc3545';
          errDiv.innerText = '⚠️ Error: ' + message.error;
          chatContainer.appendChild(errDiv);
          chatContainer.scrollTop = chatContainer.scrollHeight;
          break;
        }
        case 'proposedFiles': {
          for (const f of message.files) {
            const card = document.createElement('div');
            card.className = 'file-card';
            const fileName = f.path.split(/[/\\\\]/).pop();
            const cleanPath = f.path.replace(/\\\\/g, '/');
            card.innerHTML = '<span class="file-path">' + fileName + ' (' + f.hunksCount + ' hunks)</span>' +
              '<div><button class="btn btn-secondary review-btn" data-path="' + cleanPath + '">Review</button> ' +
              '<button class="btn accept-btn" data-path="' + cleanPath + '">Accept All</button></div>';
            chatContainer.appendChild(card);
          }
          chatContainer.scrollTop = chatContainer.scrollHeight;
          break;
        }
        case 'endStreaming': {
          stopBtn.style.display = 'none';
          sendBtn.style.display = 'block';
          currentAgentMsgDiv = null;
          break;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
