import type { Env } from '../index';

export interface CLIBridgeConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
}

export interface StreamRequest {
  provider: string;
  model: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

export interface SkillUploadRequest {
  skillName: string;
  manifest: string;
  template: string;
}

export class CLIBridgeClient {
  private config: CLIBridgeConfig;

  constructor(env: Env) {
    this.config = {
      url: env.CLIBRIDGE_URL,
      clientId: env.CLIBRIDGE_CLIENT_ID,
      clientSecret: env.CLIBRIDGE_CLIENT_SECRET,
      apiKey: env.CLIBRIDGE_API_KEY,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'CF-Access-Client-Id': this.config.clientId,
      'CF-Access-Client-Secret': this.config.clientSecret,
      'X-API-Key': this.config.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async streamAnalysis(request: StreamRequest): Promise<Response> {
    const response = await fetch(`${this.config.url}/v1/stream`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        provider: request.provider,
        model: request.model,
        system_prompt: request.systemPrompt,
        messages: request.messages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CLIBridge stream failed: ${response.status} - ${error}`);
    }

    return response;
  }

  async uploadSkill(request: SkillUploadRequest): Promise<void> {
    const formData = new FormData();
    formData.append('skill_name', request.skillName);
    formData.append('manifest', new Blob([request.manifest], { type: 'application/yaml' }), 'manifest.yaml');
    formData.append('template', new Blob([request.template], { type: 'text/plain' }), 'analyze.tmpl');

    const response = await fetch(`${this.config.url}/admin/skills/upload`, {
      method: 'POST',
      headers: {
        'CF-Access-Client-Id': this.config.clientId,
        'CF-Access-Client-Secret': this.config.clientSecret,
        'X-API-Key': this.config.apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CLIBridge skill upload failed: ${response.status} - ${error}`);
    }
  }

  async cleanupSkills(prefix: string, olderThanDays: number): Promise<void> {
    const response = await fetch(`${this.config.url}/admin/skills/cleanup`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        skill_prefix: prefix,
        older_than_days: olderThanDays,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CLIBridge cleanup failed: ${response.status} - ${error}`);
    }
  }

  async listSkills(): Promise<Array<{ name: string; path: string }>> {
    const response = await fetch(`${this.config.url}/admin/skills`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CLIBridge list skills failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }
}
