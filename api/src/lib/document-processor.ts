// Document processing for Cloudflare Workers
// Uses mammoth for DOCX text extraction
// Note: PDF text extraction requires additional libraries (pdf.js or external service)

export interface ExtractedDocument {
  text: string;
  metadata: {
    pageCount?: number;
    title?: string;
    author?: string;
  };
}

export async function extractTextFromDocument(
  fileBuffer: ArrayBuffer,
  extension: string
): Promise<ExtractedDocument> {
  const ext = extension.toLowerCase().startsWith('.')
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;

  switch (ext) {
    case '.txt':
    case '.md':
    case '.json':
      return {
        text: new TextDecoder().decode(fileBuffer),
        metadata: {},
      };

    case '.pdf':
      return extractPdfText(fileBuffer);

    case '.docx':
      return extractDocxText(fileBuffer);

    case '.pptx':
      return {
        text: `[PPTX document: ${fileBuffer.byteLength} bytes. PPTX parsing not fully implemented.]`,
        metadata: {},
      };

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

async function extractPdfText(fileBuffer: ArrayBuffer): Promise<ExtractedDocument> {
  // Note: Full PDF text extraction requires pdf.js or external OCR service
  // pdf-lib doesn't support text extraction directly
  // For now, we return file info - this is a known limitation
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    
    return {
      text: `[PDF document: ${fileBuffer.byteLength} bytes, ${pdfDoc.getPageCount()} pages.\n\n` +
            `Note: Full PDF text extraction requires external OCR service.\n` +
            `For now, this analysis will proceed with placeholder text.\n\n` +
            `File metadata:\n` +
            `  Title: ${pdfDoc.getTitle() || 'Not set'}\n` +
            `  Author: ${pdfDoc.getAuthor() || 'Not set'}\n` +
            `  Subject: ${pdfDoc.getSubject() || 'Not set'}\n` +
            `  Creator: ${pdfDoc.getCreator() || 'Not set'}]`,
      metadata: {
        pageCount: pdfDoc.getPageCount(),
        title: pdfDoc.getTitle() || undefined,
        author: pdfDoc.getAuthor() || undefined,
      },
    };
  } catch (error) {
    return {
      text: `[PDF document: ${fileBuffer.byteLength} bytes. Unable to parse: ${String(error)}]`,
      metadata: {},
    };
  }
}

async function extractDocxText(fileBuffer: ArrayBuffer): Promise<ExtractedDocument> {
  try {
    const mammoth = await import('mammoth');
    
    // Convert ArrayBuffer to Uint8Array for mammoth
    const uint8Array = new Uint8Array(fileBuffer);
    
    // Try to extract raw text first
    const rawResult = await mammoth.extractRawText({ buffer: uint8Array });
    
    if (rawResult.value && rawResult.value.trim().length > 0) {
      return {
        text: rawResult.value,
        metadata: {
          title: rawResult.value.split('\n')[0]?.substring(0, 100) || undefined,
        },
      };
    }

    return {
      text: `[DOCX file has no extractable text content]`,
      metadata: {},
    };
  } catch (error) {
    console.error('DOCX extraction error:', error);
    return {
      text: `[DOCX document: ${fileBuffer.byteLength} bytes. Unable to extract text: ${String(error)}]`,
      metadata: {},
    };
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
