import * as vscode from 'vscode';
import { TrueForgeClient, TurnDelta } from './trueforgeClient';

export class ResilienceManager {
  private client: TrueForgeClient;
  private isFallbackActive = false;

  constructor(client: TrueForgeClient) {
    this.client = client;
  }

  public async executeWithFallback(
    prompt: string,
    onDelta?: (delta: TurnDelta) => void,
    abortSignal?: AbortSignal
  ): Promise<string> {
    try {
      return await this.client.runTurn(prompt, onDelta, abortSignal);
    } catch (primaryErr: any) {
      // Check if error is an authentication error, unreachable endpoint, or network timeout
      const errMsg = (primaryErr.message || '').toLowerCase();
      const isConnectionOrAuthFailure =
        errMsg.includes('timeout') ||
        errMsg.includes('unauthorized') ||
        errMsg.includes('401') ||
        errMsg.includes('unreachable') ||
        errMsg.includes('cannot connect') ||
        errMsg.includes('econnrefused') ||
        errMsg.includes('503') ||
        errMsg.includes('headers timeout');

      if (isConnectionOrAuthFailure && !this.isFallbackActive) {
        vscode.window.showWarningMessage(
          'Forge Resilience: Primary model endpoint unreachable or key invalid. Automatically switching to fallback model...'
        );
        this.isFallbackActive = true;

        try {
          // Attempt fallback turn against secondary agent
          this.client.resetSession();
          const fallbackSessionId = await this.client.getOrCreateSession('forge-coding-agent-fallback');
          vscode.window.showInformationMessage('Forge Resilience: Successfully switched to fallback model. Resuming turn.');
          return await this.client.runTurn(prompt, onDelta, abortSignal);
        } catch (fallbackErr: any) {
          // Keep editor responsive, clean error, no files changed
          vscode.window.showErrorMessage(
            `Forge Resilience: Both primary and fallback models failed (${fallbackErr.message}). Workspace unchanged.`
          );
          throw fallbackErr;
        }
      }

      throw primaryErr;
    }
  }

  public reset(): void {
    this.isFallbackActive = false;
  }
}
