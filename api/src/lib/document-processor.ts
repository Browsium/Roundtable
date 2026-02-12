// Document processing - Cloudflare Workers compatible
// Note: Full DOCX/PDF parsing requires libraries that don't work in Workers
// We extract what we can and use the filename as additional context

export async function extractTextFromDocument(
  fileBuffer: ArrayBuffer,
  extension: string
): Promise<string> {
  const ext = extension.toLowerCase();

  switch (ext) {
    case '.txt':
    case '.md':
    case '.json':
      return new TextDecoder().decode(fileBuffer);

    case '.pdf':
      // PDF extraction not available in Workers
      return `[PDF document: ${fileBuffer.byteLength} bytes. Content extraction not available in this environment. Analysis based on filename and document metadata only.]`;

    case '.docx':
      // DOCX extraction - mammoth doesn't work in Workers
      // For now, return placeholder with file info
      // TODO: Implement ZIP/XML parsing for DOCX text extraction
      return `[DOCX document: ${fileBuffer.byteLength} bytes. Full content extraction not available in this environment. Analysis based on filename and document metadata only.]`;

    case '.pptx':
      // PPTX extraction not available in Workers
      return `[PPTX document: ${fileBuffer.byteLength} bytes. Content extraction not available in this environment. Analysis based on filename and document metadata only.]`;

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

export function getFileExtension(filename: string): string {
  const match = filename.match(/\.[^.]+$/);
  return match ? match[0].toLowerCase() : '';
}

export function generateR2Key(sessionId: string, filename: string): string {
  const timestamp = Date.now();
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `sessions/${sessionId}/${timestamp}-${sanitized}`;
}
