import * as vscode from 'vscode';
import * as path from 'path';

export interface RetrievedContextItem {
  filePath: string;
  reason: string;
  sizeBytes: number;
  content: string;
}

export interface ContextAssemblyResult {
  budgetBytes: number;
  usedBytes: number;
  items: RetrievedContextItem[];
  summaryLog: string;
  promptWithContext: string;
}

export class ContextEngine {
  private defaultBudgetBytes: number = 12 * 1024; // 12 KB lean budget for high speed and quota safety

  constructor(budgetBytes?: number) {
    if (budgetBytes) {
      this.defaultBudgetBytes = budgetBytes;
    }
  }

  public async assembleContext(userInstruction: string): Promise<ContextAssemblyResult> {
    const items: RetrievedContextItem[] = [];
    let usedBytes = 0;
    const logLines: string[] = [];

    // 1. Explicit @file mentions
    const fileMentions = this.extractFileMentions(userInstruction);
    for (const mention of fileMentions) {
      const doc = await this.findAndReadFile(mention);
      if (doc) {
        const size = Buffer.byteLength(doc.content, 'utf8');
        if (usedBytes + size <= this.defaultBudgetBytes) {
          items.push({
            filePath: doc.filePath,
            reason: `Explicit @file mention: ${mention}`,
            sizeBytes: size,
            content: doc.content,
          });
          usedBytes += size;
          logLines.push(`• Included @file: ${doc.filePath} (${Math.round(size / 1024)} KB)`);
        }
      }
    }

    // 2. Keyword/Semantic Relevance Retrieval (Task B multi-file retrieval, top 3 files max)
    const keywords = this.extractKeywords(userInstruction);
    const candidateFiles = await this.rankWorkspaceFiles(keywords);
    const topCandidates = candidateFiles.slice(0, 3);

    for (const cand of topCandidates) {
      if (items.some((i) => i.filePath === cand.filePath)) {continue;}

      let content = cand.content;
      if (content.length > 3072) {
        content = content.slice(0, 3072) + '\n... [truncated for context budget] ...';
      }

      const size = Buffer.byteLength(content, 'utf8');
      if (usedBytes + size <= this.defaultBudgetBytes) {
        items.push({
          filePath: cand.filePath,
          reason: cand.reason,
          sizeBytes: size,
          content,
        });
        usedBytes += size;
        logLines.push(`• Auto-retrieved: ${cand.filePath} [${cand.reason}] (${Math.round(size / 1024)} KB)`);
      }
    }

    const summaryLog =
      `[Context Engine] Budget: ${Math.round(this.defaultBudgetBytes / 1024)} KB | Used: ${Math.round(
        usedBytes / 1024
      )} KB | Files: ${items.length}\n` + logLines.join('\n');

    // Build enhanced prompt
    let contextHeader = `=== WORKSPACE CONTEXT (Retrieved under ${Math.round(
      this.defaultBudgetBytes / 1024
    )} KB budget) ===\n`;
    for (const item of items) {
      contextHeader += `\n--- File: ${item.filePath} (Reason: ${item.reason}) ---\n${item.content}\n`;
    }
    contextHeader += `\n=== USER INSTRUCTION ===\n${userInstruction}\n`;

    return {
      budgetBytes: this.defaultBudgetBytes,
      usedBytes,
      items,
      summaryLog,
      promptWithContext: items.length > 0 ? contextHeader : userInstruction,
    };
  }

  private extractFileMentions(text: string): string[] {
    const matches = text.match(/@([\w\.\-\/\\]+)/g);
    if (!matches) {return [];}
    return matches.map((m) => m.slice(1));
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'new', 'add', 'that', 'flask',
      'touching', 'command', 'built', 'masking', 'appearing', 'from',
      'this', 'all', 'into', 'code', 'file', 'files', 'help'
    ]);
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  private async findAndReadFile(relPath: string): Promise<{ filePath: string; content: string } | null> {
    const files = await vscode.workspace.findFiles(`**/${relPath}`, '**/node_modules/**', 1);
    if (files.length === 0) {return null;}
    try {
      const data = await vscode.workspace.fs.readFile(files[0]);
      return {
        filePath: files[0].fsPath,
        content: Buffer.from(data).toString('utf8'),
      };
    } catch {
      return null;
    }
  }

  private async rankWorkspaceFiles(
    keywords: string[]
  ): Promise<Array<{ filePath: string; content: string; score: number; reason: string }>> {
    const candidates: Array<{ filePath: string; content: string; score: number; reason: string }> = [];

    // Search common code and test directories
    const uris = await vscode.workspace.findFiles(
      '{src/**,tests/**,docs/**,*.py,*.ts,*.js,*.rst}',
      '**/{.git,node_modules,__pycache__}/**',
      50
    );

    for (const uri of uris) {
      const fsPath = uri.fsPath.toLowerCase();
      let score = 0;
      const reasons: string[] = [];

      for (const kw of keywords) {
        if (fsPath.includes(kw)) {
          score += 10;
          reasons.push(`path matches '${kw}'`);
        }
      }

      // Special heuristic for CLI / test / docs commands
      if (keywords.includes('cli') || keywords.includes('config')) {
        if (fsPath.includes('cli.py')) {
          score += 20;
          reasons.push('core CLI definition');
        }
        if (fsPath.includes('test_cli.py')) {
          score += 20;
          reasons.push('CLI test coverage');
        }
        if (fsPath.includes('cli.rst') || fsPath.includes('cli.md')) {
          score += 15;
          reasons.push('CLI documentation');
        }
      }

      if (score > 0) {
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          candidates.push({
            filePath: uri.fsPath,
            content: Buffer.from(data).toString('utf8'),
            score,
            reason: reasons.join(', '),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }

    return candidates.sort((a, b) => b.score - a.score);
  }
}
