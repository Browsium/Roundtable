// Document processing will be implemented using JavaScript libraries
// Since we're in Workers environment, we'll use pure JS approaches

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
      // PDF extraction would require pdf-parse library
      // For now, return placeholder
      return `[PDF content - ${fileBuffer.byteLength} bytes]`;
    
    case '.docx':
      // DOCX extraction would require mammoth library
      // For now, return placeholder
      return `[DOCX content - ${fileBuffer.byteLength} bytes]`;
    
    case '.pptx':
      // PPTX extraction would require pptx-parser library
      // For now, return placeholder
      return `[PPTX content - ${fileBuffer.byteLength} bytes]`;
    
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
