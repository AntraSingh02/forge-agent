import * as vscode from 'vscode';

export interface TurnDelta {
  text?: string;
  toolCall?: {
    name: string;
    args: any;
  };
  error?: string;
  done?: boolean;
}

export class TrueForgeClient {
  private baseUrl: string;
  private currentSessionId: string | null = null;
  private currentTurnId: string | null = null;
  public primaryAgentName: string = 'forge-coding-agent';
  public fallbackAgentName: string = 'forge-coding-agent-fallback';

  constructor(baseUrl: string = 'http://localhost:8790') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  public async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/models`);
      return res.ok;
    } catch {
      return false;
    }
  }

  public async getOrCreateSession(agentName?: string, forceNew: boolean = false): Promise<string> {
    if (this.currentSessionId && !forceNew) {
      return this.currentSessionId;
    }

    const targetAgent = agentName || this.primaryAgentName;
    const body = {
      agent: {
        name: targetAgent,
      },
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      if (err.message?.includes('fetch failed')) {
        throw new Error('Cannot connect to TrueForge on http://localhost:8790. Ensure TrueForge harness is running.');
      }
      throw err;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create TrueForge session (${res.status}): ${errText}`);
    }

    const json = (await res.json()) as any;
    this.currentSessionId = json.data.id;
    return this.currentSessionId!;
  }

  public async runTurn(
    prompt: string,
    onDelta?: (delta: TurnDelta) => void,
    abortSignal?: AbortSignal,
    preferredAgent?: string
  ): Promise<string> {
    let agentToUse = preferredAgent || this.primaryAgentName;

    try {
      return await this.executeTurnWithAgent(agentToUse, prompt, onDelta, abortSignal);
    } catch (err: any) {
      // If error is not a user cancellation and we haven't tried fallback yet, attempt fallback model
      if (!abortSignal?.aborted && agentToUse !== this.fallbackAgentName && !err.message?.includes('Cancelled')) {
        console.warn(`Primary agent (${agentToUse}) failed: ${err.message}. Attempting fallback to ${this.fallbackAgentName}...`);
        vscode.window.showWarningMessage(
          `Forge Resilience: Primary model endpoint unreachable or key invalid. Automatically switching to fallback model (${this.fallbackAgentName})...`
        );
        this.resetSession();
        try {
          const result = await this.executeTurnWithAgent(this.fallbackAgentName, prompt, onDelta, abortSignal);
          vscode.window.showInformationMessage(
            `Forge Resilience: Task successfully executed via fallback model (${this.fallbackAgentName}). Workspace diff ready for review.`
          );
          return result;
        } catch (fallbackErr: any) {
          vscode.window.showErrorMessage(
            `Forge Resilience: Both primary and fallback models failed (${fallbackErr.message}). Workspace remains completely unchanged.`
          );
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  private async executeTurnWithAgent(
    agentName: string,
    prompt: string,
    onDelta?: (delta: TurnDelta) => void,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const sessionId = await this.getOrCreateSession(agentName, false);

    const turnPayload = {
      stream: true,
      input: [
        {
          type: 'user.message',
          content: prompt,
        },
      ],
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(turnPayload),
        signal: abortSignal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Cancelled by user');
      }
      throw err;
    }

    // If session was locked or invalid, create new session and retry once
    if (response.status === 400 || response.status === 404 || response.status === 409) {
      this.resetSession();
      const freshSessionId = await this.getOrCreateSession(agentName, true);
      response = await fetch(`${this.baseUrl}/api/v1/sessions/${freshSessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(turnPayload),
        signal: abortSignal,
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TrueForge turn error (${response.status}): ${errText}`);
    }

    // Process SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No readable stream from TrueForge');
    }

    const decoder = new TextDecoder();
    let accumulatedText = '';
    let buffer = '';
    let recordedTurnId: string | null = null;

    while (true) {
      if (abortSignal?.aborted) {
        reader.cancel();
        throw new Error('Cancelled by user');
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {
          continue;
        }

        if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') {
            onDelta?.({ done: true });
            continue;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (parsed.turn_id) {
            recordedTurnId = parsed.turn_id;
            this.currentTurnId = parsed.turn_id;
          }

          // TrueForge delivers delta text either in parsed.content or parsed.delta.content
          const textChunk =
            parsed.content ||
            parsed.delta?.content ||
            parsed.output?.content ||
            (parsed.type === 'delta' ? parsed.text : '');

          if (textChunk) {
            accumulatedText += textChunk;
            onDelta?.({ text: textChunk });
          }

          if (parsed.type === 'turn.done') {
            const fullOut = parsed.state?.output?.content;
            if (fullOut && !accumulatedText) {
              accumulatedText = fullOut;
              onDelta?.({ text: fullOut });
            }
            onDelta?.({ done: true });
          }

          if (parsed.state?.status === 'paused') {
            // Turn entered paused state (e.g. tool execution checkpoint)
            onDelta?.({ done: true });
          }

          if (parsed.state?.status === 'error' || parsed.type === 'error' || parsed.error) {
            const errMsg =
              parsed.state?.error?.message ||
              parsed.state?.message ||
              parsed.error?.message ||
              parsed.message ||
              'TrueForge turn error';
            this.resetSession();
            onDelta?.({ error: errMsg });
            throw new Error(errMsg);
          }
        }
      }
    }

    // Fallback: If no text was accumulated over SSE, query the turn events
    if (!accumulatedText.trim() && recordedTurnId && this.currentSessionId) {
      try {
        const eventsRes = await fetch(`${this.baseUrl}/api/v1/sessions/${this.currentSessionId}/turns/${recordedTurnId}/events`);
        if (eventsRes.ok) {
          const eventsJson = (await eventsRes.json()) as any;
          const events = eventsJson.data || [];
          for (const ev of events) {
            if (ev.content && typeof ev.content === 'string') {
              accumulatedText += ev.content;
            } else if (ev.output?.content) {
              accumulatedText += ev.output.content;
            }
          }
          if (accumulatedText) {
            onDelta?.({ text: accumulatedText, done: true });
          }
        }
      } catch {
        // Ignore fallback error
      }
    }

    return accumulatedText;
  }

  public async cancelCurrentTurn(): Promise<void> {
    if (this.currentSessionId && this.currentTurnId) {
      try {
        await fetch(`${this.baseUrl}/api/v1/sessions/${this.currentSessionId}/turns/${this.currentTurnId}/cancel`, {
          method: 'POST',
        });
      } catch {
        // Ignored
      }
    }
  }

  public resetSession(): void {
    this.currentSessionId = null;
    this.currentTurnId = null;
  }
}
