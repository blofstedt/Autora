export interface AnnotationItem {
  id: string;
  type: 'signature' | 'text' | 'stamp' | 'drawing' | 'highlighter' | 'redact' | 'shape' | 'note' | 'image';
  pageNumber: number; // 1-indexed page number
  
  // Coordinates relative to original PDF page size (units in points, top-left origin)
  x: number; 
  y: number;
  width: number;
  height: number;

  // Signatures & Placed Images
  signatureDataUrl?: string; // Base64 PNG image
  imageDataUrl?: string;

  // Text insertions
  text?: string;
  fontSize?: number;
  fontColor?: string;
  fontFamily?: string;

  // Stamps
  stampType?: 'APPROVED' | 'REJECTED' | 'SIGN_HERE' | 'INITIAL_HERE' | 'DATE' | 'CHECKMARK' | 'CROSS' | 'CONFIDENTIAL' | 'COPY';

  // Ink drawing & Highlighter
  drawingPoints?: { x: number; y: number }[]; // Coordinates list relative to the original page size
  drawingColor?: string;
  drawingWidth?: number;
  highlighterOpacity?: number;
  isHighlighter?: boolean;

  // Shapes
  shapeType?: 'rectangle' | 'circle' | 'line' | 'arrow';
  shapeFillColor?: string;
  hasFill?: boolean;
  shapeStrokeColor?: string;
  shapeStrokeWidth?: number;
  hasStroke?: boolean;

  // Sticky notes / Comments
  noteComment?: string;
  noteAuthor?: string;
  noteColor?: string;
  noteDate?: string;
  isNoteOpen?: boolean;

  userResized?: boolean;
}

export interface WatermarkConfig {
  enabled: boolean;
  text: string;
  fontSize: number;
  color: string;
  opacity: number;
  rotationAngle: number;
  pages: 'all' | 'first' | 'range';
  pageRange?: string;
}

export interface PageNumberConfig {
  enabled: boolean;
  position: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left';
  format: 'page-of-total' | 'page-only' | 'dash-page';
  fontSize: number;
  color: string;
  startNumber: number;
}

export interface PDFPageSize {
  width: number;
  height: number;
}

export interface SavedSignature {
  id: string;
  dataUrl: string;
  label: string;
  createdAt: string;
}

export interface ActivityLog {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'security';
}
