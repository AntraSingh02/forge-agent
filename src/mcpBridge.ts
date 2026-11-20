import * as http from 'http';
import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager } from './diffManager';

export class MCPBridge {
  private server: http.Server | null = null;
  private port: number = 8792;
  private diffManager: DiffManager;
  private trueforgeBaseUrl: string;

  constructor(diffManager: DiffManager, trueforgeBaseUrl: string = 'http://localhost:8790') {
    this.diffManager = diffManager;
    this.trueforgeBaseUrl = trueforgeBaseUrl;
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

        // Health / Info
        if (url.pathname === '/' || url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', name: 'vscode-mcp-tools' }));
          return;
        }

        // List MCP Tools
        if (url.pathname === '/tools' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              tools: [
                {
                  name: 'read_file',
                  description: 'Read the contents of a file in the workspace',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'Relative or absolute file path' },
                      start_line: { type: 'number', description: 'Optional starting line (1-based)' },
                      end_line: { type: 'number', description: 'Optional ending line' },
                    },
                    required: ['path'],
                  },
                },
                {
                  name: 'search_workspace',
                  description: 'Search workspace files for matching text or regex',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string', description: 'Text to search for' },
                    },
                    required: ['query'],
                  },
                },
                {
                  name: 'propose_edit',
                  description:
                    'Propose edits to a file. Never writes silently to disk; presents diff hunks for user review.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'File path to edit' },
                      new_content: { type: 'string', description: 'Complete proposed new content for the file' },
                    },
                    required: ['path', 'new_content'],
                  },
                },
                {
                  name: 'run_terminal_command',
                  description: 'Execute a terminal command in the workspace and return output',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      command: { type: 'string', description: 'Shell command to execute (e.g. pytest)' },
                    },
                    required: ['command'],
                  },
                },
              ],
            })
          );
          return;
        }

        // Call MCP Tool
        if (url.pathname === '/call' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const { name, args } = JSON.parse(body);
              const result = await this.executeTool(name, args);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ result }));
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[MCP Bridge] Port ${this.port} is busy. Trying port ${this.port + 1}...`);
          this.port++;
          try {
            this.server?.listen(this.port, '127.0.0.1');
          } catch {
            resolve();
          }
        } else {
          console.warn('[MCP Bridge] Server error:', err.message);
          resolve();
        }
      });

      try {
        this.server.listen(this.port, '127.0.0.1', async () => {
          console.log(`[MCP Bridge] Listening on http://127.0.0.1:${this.port}`);
          await this.registerWithTrueForge().catch(() => {});
          resolve();
        });
      } catch (err: any) {
        console.warn('[MCP Bridge] Could not bind server:', err.message);
        resolve();
      }
    });
  }

  public async registerWithTrueForge(): Promise<void> {
    try {
      const payload = {
        manifest: {
          type: 'remote',
          name: 'vscode-tools',
          url: `http://127.0.0.1:${this.port}/tools`,
          description: 'VS Code editor MCP tools for reading files, searching, diff proposals, and terminal commands',
        },
      };

      await fetch(`${this.trueforgeBaseUrl}/api/v1/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log('[MCP Bridge] Registered vscode-tools with TrueForge');
    } catch (e) {
      console.warn('[MCP Bridge] Could not register with TrueForge (harness may register on demand)');
    }
  }

  public async executeTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'read_file': {
        const fullPath = this.resolvePath(args.path);
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
        let content = Buffer.from(data).toString('utf8');

        if (args.start_line || args.end_line) {
          const lines = content.split('\n');
          const start = Math.max(0, (args.start_line || 1) - 1);
          const end = args.end_line ? Math.min(lines.length, args.end_line) : lines.length;
          content = lines.slice(start, end).join('\n');
        }
        return { content };
      }

      case 'search_workspace': {
        const query = args.query;
        const matches: Array<{ file: string; line: number; text: string }> = [];
        const files = await vscode.workspace.findFiles('**/*', '**/{.git,node_modules,__pycache__}/**', 50);

        for (const file of files) {
          try {
            const data = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(data).toString('utf8');
            const lines = text.split('\n');
            lines.forEach((line, index) => {
              if (line.includes(query)) {
                matches.push({
                  file: vscode.workspace.asRelativePath(file),
                  line: index + 1,
                  text: line.trim(),
                });
              }
            });
          } catch {
            // Ignore unreadable
          }
          if (matches.length > 30) {break;}
        }
        return { matches };
      }

      case 'propose_edit': {
        const fullPath = this.resolvePath(args.path);
        const fileUri = vscode.Uri.file(fullPath);
        let originalContent = '';
        try {
          const data = await vscode.workspace.fs.readFile(fileUri);
          originalContent = Buffer.from(data).toString('utf8');
        } catch {
          originalContent = ''; // New file creation
        }

        const fileDiff = this.diffManager.proposeDiff(fullPath, originalContent, args.new_content);

        // Open the document in editor so user sees hunks immediately
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });

        return {
          status: 'diff_proposed_for_review',
          filePath: fullPath,
          hunksCount: fileDiff.hunks.length,
          message: 'Changes are displayed in editor with per-hunk Accept/Reject CodeLenses. Waiting for user review.',
        };
      }

      case 'run_terminal_command': {
        return new Promise((resolve) => {
          const cp = require('child_process');
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
          cp.exec(args.command, { cwd }, (err: any, stdout: string, stderr: string) => {
            resolve({
              exitCode: err ? err.code || 1 : 0,
              stdout: stdout || '',
              stderr: stderr || '',
            });
          });
        });
      }

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  private resolvePath(relOrAbs: string): string {
    if (path.isAbsolute(relOrAbs)) {
      return relOrAbs;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return path.join(root, relOrAbs);
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
