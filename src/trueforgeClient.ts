import * as http from 'http';

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
  private primaryAgentName: string = 'forge-coding-agent';
  private fallbackAgentName: string = 'forge-coding-agent-fallback';

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

  public async getOrCreateSession(agentName?: string): Promise<string> {
    if (this.currentSessionId) {
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
    abortSignal?: AbortSignal
  ): Promise<string> {
    const sessionId = await this.getOrCreateSession();

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

    while (true) {
      if (abortSignal?.aborted) {
        reader.cancel();
        throw new Error('Cancelled by user');
      }

      const { done, value } = await reader.read();
      if (done) {break;}

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {continue;}

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
            continue; // Ignore JSON parse errors on partial frames
          }

          // Handle trueforge SSE event structure
          const textChunk =
            parsed.delta?.content ||
            parsed.output?.content ||
            parsed.content ||
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

          if (parsed.turn_id) {
            this.currentTurnId = parsed.turn_id;
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
