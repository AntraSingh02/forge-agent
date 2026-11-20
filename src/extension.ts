import * as vscode from 'vscode';
import { TrueForgeClient } from './trueforgeClient';
import { DiffManager } from './diffManager';
import { ContextEngine } from './contextEngine';
import { MCPBridge } from './mcpBridge';
import { InlineEditController } from './inlineEdit';
import { AgentPanelProvider } from './agentPanel';
import { ResilienceManager } from './resilience';

let mcpBridge: MCPBridge | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Forge Agent] Activating extension...');

  // Initialize Core Services
  const trueforgeClient = new TrueForgeClient('http://localhost:8790');
  const diffManager = new DiffManager();
  const contextEngine = new ContextEngine(24 * 1024);
  const resilienceManager = new ResilienceManager(trueforgeClient);

  // Initialize embedded MCP Bridge server instance
  mcpBridge = new MCPBridge(diffManager, 'http://localhost:8790');

  // Controllers
  const inlineEditController = new InlineEditController(trueforgeClient, diffManager);
  const agentPanelProvider = new AgentPanelProvider(
    context.extensionUri,
    trueforgeClient,
    diffManager,
    contextEngine,
    mcpBridge
  );

  // 1. REGISTER WEBVIEW IMMEDIATELY — NEVER BLOCK BEFORE THIS!
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentPanelProvider.viewType,
      agentPanelProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // 2. Register CodeLens and active editor listener
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**/*' }, diffManager),
    vscode.window.onDidChangeActiveTextEditor(() => {
      diffManager.refreshEditorDecorations();
    })
  );

  // 3. Register Commands Immediately
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.inlineEdit', async () => {
      await inlineEditController.triggerInlineEdit();
    }),

    vscode.commands.registerCommand('forge.acceptHunk', async (hunkId: string) => {
      await diffManager.acceptHunk(hunkId);
    }),

    vscode.commands.registerCommand('forge.rejectHunk', async (hunkId: string) => {
      await diffManager.rejectHunk(hunkId);
    }),

    vscode.commands.registerCommand('forge.acceptAllHunks', async (filePath: string) => {
      await diffManager.acceptAll(filePath);
    }),

    vscode.commands.registerCommand('forge.rejectAllHunks', (filePath: string) => {
      diffManager.rejectAll(filePath);
    }),

    vscode.commands.registerCommand('forge.undoChange', async () => {
      await diffManager.undoLastChange();
    }),

    vscode.commands.registerCommand('forge.openAgentPanel', () => {
      vscode.commands.executeCommand('forge.agentView.focus');
    })
  );

  // 4. Start MCP Bridge in background (never blocks extension activation or webview view)
  mcpBridge.start().catch((err) => {
    console.warn('[Forge Agent] MCP Bridge warning:', err);
  });
  context.subscriptions.push({
    dispose: () => {
      if (mcpBridge) {
        mcpBridge.stop();
        mcpBridge = null;
      }
    },
  });

  // 5. Asynchronous health check
  trueforgeClient.isHealthy().then((healthy) => {
    if (healthy) {
      vscode.window.showInformationMessage('Forge Agent connected to TrueForge local harness (port 8790). Ready!');
    } else {
      vscode.window.showWarningMessage('Forge Agent: TrueForge harness not detected on port 8790. Run: npx @truefoundry/trueforge');
    }
  }).catch(() => {});

  console.log('[Forge Agent] Extension activated successfully.');
}

export function deactivate() {
  if (mcpBridge) {
    mcpBridge.stop();
    mcpBridge = null;
  }
}
