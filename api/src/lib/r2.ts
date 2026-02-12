import type { R2Bucket } from '@cloudflare/workers-types';

export class R2Client {
  private bucket: R2Bucket;
  private bucketName: string;
  private accountId: string;

  constructor(bucket: R2Bucket, accountId: string) {
    this.bucket = bucket;
    this.bucketName = 'roundtable-documents';
    this.accountId = accountId;
  }

  async uploadDocument(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
    await this.bucket.put(key, data, {
      httpMetadata: {
        contentType,
      },
    });
  }

  async getDocument(key: string): Promise<ReadableStream | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return object.body;
  }

  async deleteDocument(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  generatePresignedUploadUrl(key: string, contentType: string, expirationSeconds: number = 300): string {
    // Note: R2 doesn't support presigned URLs natively like S3
    // We'll use Workers to proxy uploads instead
    return `/r2/upload/${key}`;
  }

  getPublicUrl(key: string): string {
    // R2 objects are private, access through Workers API only
    return `/r2/documents/${key}`;
  }
}
