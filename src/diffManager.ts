import * as vscode from 'vscode';
import * as diff from 'diff';

export interface DiffHunk {
  id: string;
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: string[];
  removedLines: string[];
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ProposedFileDiff {
  filePath: string;
  originalContent: string;
  proposedContent: string;
  hunks: DiffHunk[];
  status: 'pending' | 'accepted' | 'rejected';
}

export class DiffManager implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private proposedDiffs = new Map<string, ProposedFileDiff>();
  private undoStack: Array<{ filePath: string; previousContent: string }> = [];

  private addedDecoration: vscode.TextEditorDecorationType;
  private removedDecoration: vscode.TextEditorDecorationType;

  constructor() {
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(40, 167, 69, 0.25)',
      isWholeLine: true,
      overviewRulerColor: 'green',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.removedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(220, 53, 69, 0.25)',
      isWholeLine: true,
      overviewRulerColor: 'red',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  public proposeDiff(filePath: string, originalContent: string, proposedContent: string): ProposedFileDiff {
    const rawPatch = diff.structuredPatch(filePath, filePath, originalContent, proposedContent, '', '');
    const hunks: DiffHunk[] = rawPatch.hunks.map((h, index) => {
      const added: string[] = [];
      const removed: string[] = [];

      h.lines.forEach((line) => {
        if (line.startsWith('+')) {
          added.push(line.slice(1));
        } else if (line.startsWith('-')) {
          removed.push(line.slice(1));
        }
      });

      return {
        id: `${filePath}#hunk-${index}`,
        filePath,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        addedLines: added,
        removedLines: removed,
        status: 'pending',
      };
    });

    const fileDiff: ProposedFileDiff = {
      filePath,
      originalContent,
      proposedContent,
      hunks,
      status: 'pending',
    };

    const key = this.normalizePath(filePath);
    this.proposedDiffs.set(key, fileDiff);
    this.refreshEditorDecorations();
    this._onDidChangeCodeLenses.fire();

    return fileDiff;
  }

  public getProposedDiff(filePath: string): ProposedFileDiff | undefined {
    return this.proposedDiffs.get(this.normalizePath(filePath));
  }

  public getAllProposedDiffs(): ProposedFileDiff[] {
    return Array.from(this.proposedDiffs.values());
  }

  public async acceptHunk(hunkId: string): Promise<boolean> {
    for (const [key, fileDiff] of this.proposedDiffs.entries()) {
      const hunk = fileDiff.hunks.find((h) => h.id === hunkId);
      if (hunk) {
        hunk.status = 'accepted';
        await this.applyAcceptedHunks(fileDiff.filePath);
        return true;
      }
    }
    return false;
  }

  public async rejectHunk(hunkId: string): Promise<boolean> {
    for (const [, fileDiff] of this.proposedDiffs.entries()) {
      const hunk = fileDiff.hunks.find((h) => h.id === hunkId);
      if (hunk) {
        hunk.status = 'rejected';
        this.refreshEditorDecorations();
        this._onDidChangeCodeLenses.fire();
        return true;
      }
    }
    return false;
  }

  public async acceptAll(filePath: string): Promise<void> {
    const key = this.normalizePath(filePath);
    const fileDiff = this.proposedDiffs.get(key);
    if (!fileDiff) {
      console.warn(`[DiffManager] No proposed diff found for key: ${key}`);
      return;
    }

    // Save current content to undo stack before writing to disk
    this.undoStack.push({
      filePath: fileDiff.filePath,
      previousContent: fileDiff.originalContent,
    });

    fileDiff.hunks.forEach((h) => (h.status = 'accepted'));
    fileDiff.status = 'accepted';

    // Apply change directly to file using workspace fs (bulletproof for both new and existing files)
    const uri = vscode.Uri.file(fileDiff.filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(fileDiff.proposedContent, 'utf8'));

    // Open and show in editor
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {}

    this.proposedDiffs.delete(key);
    this.refreshEditorDecorations();
    this._onDidChangeCodeLenses.fire();

    vscode.window.showInformationMessage(`✓ Applied edits to ${vscode.workspace.asRelativePath(fileDiff.filePath)}`);
  }

  public rejectAll(filePath: string): void {
    const key = this.normalizePath(filePath);
    const fileDiff = this.proposedDiffs.get(key);
    const displayPath = fileDiff?.filePath || filePath;
    this.proposedDiffs.delete(key);
    this.refreshEditorDecorations();
    this._onDidChangeCodeLenses.fire();
    vscode.window.showInformationMessage(`Rejected edits for ${vscode.workspace.asRelativePath(displayPath)}`);
  }

  public async undoLastChange(): Promise<boolean> {
    const lastChange = this.undoStack.pop();
    if (!lastChange) {
      vscode.window.showWarningMessage('No applied changes to undo.');
      return false;
    }

    const uri = vscode.Uri.file(lastChange.filePath);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, 999999, 0);
    edit.replace(uri, fullRange, lastChange.previousContent);
    await vscode.workspace.applyEdit(edit);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();

    vscode.window.showInformationMessage(`Undid last change to ${vscode.workspace.asRelativePath(lastChange.filePath)}`);
    return true;
  }

  public clearAll(): void {
    this.proposedDiffs.clear();
    this.refreshEditorDecorations();
    this._onDidChangeCodeLenses.fire();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const filePath = document.uri.fsPath;
    const fileDiff = this.proposedDiffs.get(this.normalizePath(filePath));
    if (!fileDiff) {return [];}

    const lenses: vscode.CodeLens[] = [];

    // Top file header actions
    lenses.push(
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: '✓ Accept All Hunks',
        command: 'forge.acceptAllHunks',
        arguments: [filePath],
      }),
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: '✗ Reject All',
        command: 'forge.rejectAllHunks',
        arguments: [filePath],
      })
    );

    if (this.undoStack.length > 0) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: '↺ Undo Last Change',
          command: 'forge.undoChange',
        })
      );
    }

    // Per-hunk CodeLens
    for (const hunk of fileDiff.hunks) {
      if (hunk.status !== 'pending') {continue;}
      const lineNum = Math.max(0, hunk.oldStart - 1);
      const range = new vscode.Range(lineNum, 0, lineNum, 0);

      lenses.push(
        new vscode.CodeLens(range, {
          title: `✓ Accept Hunk`,
          command: 'forge.acceptHunk',
          arguments: [hunk.id],
        }),
        new vscode.CodeLens(range, {
          title: `✗ Reject Hunk`,
          command: 'forge.rejectHunk',
          arguments: [hunk.id],
        })
      );
    }

    return lenses;
  }

  private async applyAcceptedHunks(filePath: string): Promise<void> {
    const fileDiff = this.proposedDiffs.get(this.normalizePath(filePath));
    if (!fileDiff) {return;}

    const pendingHunks = fileDiff.hunks.filter((h) => h.status === 'pending');
    if (pendingHunks.length === 0) {
      // All hunks reviewed
      await this.acceptAll(filePath);
    } else {
      this.refreshEditorDecorations();
      this._onDidChangeCodeLenses.fire();
    }
  }

  public refreshEditorDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {return;}

    const filePath = editor.document.uri.fsPath;
    const fileDiff = this.proposedDiffs.get(this.normalizePath(filePath));
    if (!fileDiff) {
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.removedDecoration, []);
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];

    for (const hunk of fileDiff.hunks) {
      if (hunk.status !== 'pending') {continue;}
      const startLine = Math.max(0, hunk.oldStart - 1);
      const count = Math.max(1, hunk.oldLines);
      removedRanges.push(new vscode.Range(startLine, 0, startLine + count - 1, 0));
    }

    editor.setDecorations(this.removedDecoration, removedRanges);
    editor.setDecorations(this.addedDecoration, addedRanges);
  }
}
