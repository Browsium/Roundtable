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
    const url = `${this.config.url}/v1/stream`;
    const headers = this.getHeaders();
    const body = JSON.stringify({
      provider: request.provider,
      model: request.model,
      system_prompt: request.systemPrompt,
      messages: request.messages,
    });

    // Log the request for debugging (remove in production)
    console.log('CLIBridge streamAnalysis request:', { 
      url, 
      headers: {
        'CF-Access-Client-Id': headers['CF-Access-Client-Id'] ? '[REDACTED]' : undefined,
        'CF-Access-Client-Secret': headers['CF-Access-Client-Secret'] ? '[REDACTED]' : undefined,
        'X-API-Key': headers['X-API-Key'] ? '[REDACTED]' : undefined,
        'Content-Type': headers['Content-Type']
      }, 
      bodyPreview: body.substring(0, 200) + '...' 
    });

    // Retry logic for transient failures
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`CLIBridge streamAnalysis attempt ${attempt}`);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
        });

        console.log(`CLIBridge streamAnalysis response attempt ${attempt}:`, { 
          status: response.status, 
          statusText: response.statusText,
          headers: [...response.headers.entries()]
        });

        if (response.ok) {
          console.log(`CLIBridge streamAnalysis successful attempt ${attempt}`);
          return response;
        }

        const error = await response.text();
        const errorInfo = `CLIBridge stream failed: ${response.status} ${response.statusText} - ${error.substring(0, 500)}`;
        console.error(`CLIBridge error (attempt ${attempt}):`, errorInfo);
        
        lastError = new Error(errorInfo);
        
        // Don't retry on client errors (4xx), only on server errors (5xx) or network issues
        if (response.status < 500 && response.status >= 400) {
          console.log(`CLIBridge streamAnalysis breaking retry loop on client error ${response.status}`);
          break;
        }
        
        // Wait before retrying (exponential backoff)
        if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`CLIBridge streamAnalysis waiting ${delay}ms before retry ${attempt + 1}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`CLIBridge network error (attempt ${attempt}):`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Wait before retrying
        if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`CLIBridge streamAnalysis waiting ${delay}ms before retry ${attempt + 1} after network error`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error('CLIBridge streamAnalysis failed after all retries:', lastError);
    throw lastError || new Error('CLIBridge stream failed after 3 attempts');
  }

  async uploadSkill(request: SkillUploadRequest): Promise<void> {
    const formData = new FormData();
    formData.append('skill_name', request.skillName);
    formData.append('manifest', new Blob([request.manifest], { type: 'application/yaml' }), 'manifest.yaml');
    formData.append('template', new Blob([request.template], { type: 'text/plain' }), 'analyze.tmpl');

    const url = `${this.config.url}/admin/skills/upload`;
    const headers = {
      'CF-Access-Client-Id': this.config.clientId,
      'CF-Access-Client-Secret': this.config.clientSecret,
      'X-API-Key': this.config.apiKey,
    };

    // Retry logic for transient failures
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: formData,
        });

        if (response.ok) {
          return;
        }

        const error = await response.text();
        const errorInfo = `CLIBridge skill upload failed: ${response.status} ${response.statusText} - ${error.substring(0, 500)}`;
        console.error(`CLIBridge upload error (attempt ${attempt}):`, errorInfo);
        
        lastError = new Error(errorInfo);
        
        // Don't retry on client errors (4xx), only on server errors (5xx) or network issues
        if (response.status < 500 && response.status >= 400) {
          break;
        }
        
        // Wait before retrying (exponential backoff)
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      } catch (error) {
        console.error(`CLIBridge upload network error (attempt ${attempt}):`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Wait before retrying
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    throw lastError || new Error('CLIBridge skill upload failed after 3 attempts');
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
