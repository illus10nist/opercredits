
import os
from typing import Dict, List, Any

def _norm_bbox(b, page_width, page_height):
    x0, y0, x1, y1 = b
    return [
        max(0.0, min(1.0, x0 / page_width)),
        max(0.0, min(1.0, y0 / page_height)),
        max(0.0, min(1.0, x1 / page_width)),
        max(0.0, min(1.0, y1 / page_height)),
    ]

class LocalPDFExtractor:
    """Lightweight extractor: words + normalized bounding boxes (0..1)."""
    def __init__(self):
        try:
            import fitz  # PyMuPDF
        except Exception as e:
            raise RuntimeError("PyMuPDF (fitz) is required. Please install it.") from e
        self.fitz = fitz

    def extract(self, pdf_path: str) -> Dict[str, Any]:
        doc = self.fitz.open(pdf_path)
        pages: List[Dict[str, Any]] = []
        for page_idx in range(len(doc)):
            page = doc[page_idx]
            w, h = page.rect.width, page.rect.height
            words = page.get_text("words")
            words_struct = []
            for x0, y0, x1, y1, text, block_no, line_no, word_no in words:
                words_struct.append({
                    "text": text,
                    "bbox": _norm_bbox([x0, y0, x1, y1], w, h),
                    "block": int(block_no),
                    "line": int(line_no),
                    "word": int(word_no),
                })
            pages.append({"width": w, "height": h, "words": words_struct})
        doc.close()
        return {"pages": pages}

class DocAIExtractor:
    """Optional: Google Document AI extractor using 'process_document'.
    Returns a structure compatible with LocalPDFExtractor: pages -> words (text + normalized bbox).
    """
    def __init__(self, project_id: str, location: str, processor_id: str):
        self.project_id = project_id
        self.location = location
        self.processor_id = processor_id
        try:
            from google.cloud import documentai  # type: ignore
        except Exception as e:
            raise RuntimeError("google-cloud-documentai is required for DocAIExtractor.") from e
        self.documentai = documentai

    def extract(self, pdf_path: str) -> Dict[str, Any]:
        from google.cloud import documentai
        client = documentai.DocumentProcessorServiceClient()
        name = client.processor_path(self.project_id, self.location, self.processor_id)
        with open(pdf_path, "rb") as f:
            raw_document = documentai.RawDocument(content=f.read(), mime_type="application/pdf")

        request = documentai.ProcessRequest(name=name, raw_document=raw_document)
        result = client.process_document(request=request)
        doc = result.document

        pages_out = []
        for p in doc.pages:
            page_width = p.dimension.width or 1.0
            page_height = p.dimension.height or 1.0
            words_struct = []
            for token in p.tokens:
                text = _text_for_layout(doc, token.layout)
                bbox = _poly_to_bbox(token.layout.bounding_poly, page_width, page_height)
                words_struct.append({
                    "text": text,
                    "bbox": bbox,
                    "block": 0,
                    "line": 0,
                    "word": 0,
                })
            pages_out.append({"width": page_width, "height": page_height, "words": words_struct})
        return {"pages": pages_out}

def _text_for_layout(document, layout) -> str:
    if not layout.text_anchor.text_segments:
        return ""
    text = ""
    for seg in layout.text_anchor.text_segments:
        start = int(seg.start_index) if seg.start_index is not None else 0
        end = int(seg.end_index) if seg.end_index is not None else 0
        text += document.text[start:end]
    return text.strip()

def _poly_to_bbox(poly, w, h):
    if getattr(poly, "normalized_vertices", None):
        xs = [v.x for v in poly.normalized_vertices]
        ys = [v.y for v in poly.normalized_vertices]
    else:
        xs = [v.x / w for v in poly.vertices]
        ys = [v.y / h for v in poly.vertices]
    if not xs or not ys:
        return [0.0, 0.0, 0.0, 0.0]
    return [max(0.0, min(xs)), max(0.0, min(ys)), max(0.0, min(1.0, max(xs))), max(0.0, min(1.0, max(ys)))]
