import * as vscode from 'vscode';
import { TrueForgeClient } from './trueforgeClient';
import { DiffManager } from './diffManager';

export class InlineEditController {
  private client: TrueForgeClient;
  private diffManager: DiffManager;

  constructor(client: TrueForgeClient, diffManager: DiffManager) {
    this.client = client;
    this.diffManager = diffManager;
  }

  public async triggerInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor found.');
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const selectedText = document.getText(selection);

    if (!selectedText || selectedText.trim().length === 0) {
      vscode.window.showInformationMessage('Please highlight a section of code to inline-edit.');
      return;
    }

    const instruction = await vscode.window.showInputBox({
      prompt: 'Enter instructions for Forge Agent (e.g. "Treat the values \'off\' and \'n\' as false as well...")',
      placeHolder: 'What would you like to change in the selected code?',
    });

    if (!instruction) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Forge Agent: Planning and generating inline edit...',
        cancellable: true,
      },
      async (progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
          abortController.abort();
          this.client.cancelCurrentTurn();
        });

        try {
          const filePath = document.uri.fsPath;
          const fullContent = document.getText();
          const startOffset = document.offsetAt(selection.start);
          const endOffset = document.offsetAt(selection.end);

          const prompt = `You are an expert code editor.
File: ${vscode.workspace.asRelativePath(filePath)}

Selected Code snippet to edit:
\`\`\`python
${selectedText}
\`\`\`

User Instruction:
${instruction}

Task:
Return ONLY the updated code snippet that directly replaces the selected snippet.
Do not wrap in markdown quotes if possible, or return inside a single \`\`\`python ... \`\`\` block.`;

          progress.report({ message: 'Contacting TrueForge agent...' });
          const rawResponse = await this.client.runTurn(
            prompt,
            (delta) => {
              if (delta.text) {
                progress.report({ message: `Streaming edits...` });
              }
            },
            abortController.signal
          );

          // Clean response text
          let replacement = rawResponse.trim();
          const codeBlockMatch = replacement.match(/```(?:python|py)?\r?\n([\s\S]*?)```/);
          if (codeBlockMatch) {
            replacement = codeBlockMatch[1];
          }

          // Build proposed new full file content
          const proposedFullContent =
            fullContent.substring(0, startOffset) + replacement + fullContent.substring(endOffset);

          // Propose diff hunk-by-hunk
          const proposed = this.diffManager.proposeDiff(filePath, fullContent, proposedFullContent);

          vscode.window.showInformationMessage(
            `Forge Agent: Proposed ${proposed.hunks.length} hunk(s). Review in editor and click Accept or Reject.`
          );
        } catch (err: any) {
          if (err.message.includes('Cancelled')) {
            vscode.window.showInformationMessage('Inline edit cancelled. Workspace unchanged.');
          } else {
            vscode.window.showErrorMessage(`Forge Agent error: ${err.message}`);
          }
        }
      }
    );
  }
}
