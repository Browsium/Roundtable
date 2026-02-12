// Document processing using JavaScript libraries
import mammoth from 'mammoth';

export async function extractTextFromDocument(
  fileBuffer: ArrayBuffer,
  extension: string
): Promise<string> {
  const ext = extension.toLowerCase();
  const buffer = Buffer.from(fileBuffer);

  switch (ext) {
    case '.txt':
    case '.md':
    case '.json':
      return new TextDecoder().decode(fileBuffer);

    case '.pdf':
      // PDF extraction - try to extract text, fallback to placeholder
      try {
        // Note: pdf-parse doesn't work well in Workers
        // For now, return placeholder with file size info
        return `[PDF content - ${fileBuffer.byteLength} bytes. PDF parsing not fully implemented in Workers environment.]`;
      } catch {
        return `[PDF content - ${fileBuffer.byteLength} bytes]`;
      }

    case '.docx':
      // DOCX extraction using mammoth
      try {
        const result = await mammoth.extractRawText({ buffer });
        if (result.value && result.value.trim().length > 0) {
          return result.value;
        }
        return `[DOCX file parsed but no text content found - ${fileBuffer.byteLength} bytes]`;
      } catch (error) {
        console.error('DOCX parsing error:', error);
        return `[DOCX content - ${fileBuffer.byteLength} bytes. Parsing error: ${error}]`;
      }

    case '.pptx':
      // PPTX extraction - not fully implemented
      try {
        return `[PPTX content - ${fileBuffer.byteLength} bytes. PPTX parsing not fully implemented in Workers environment.]`;
      } catch {
        return `[PPTX content - ${fileBuffer.byteLength} bytes]`;
      }

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
