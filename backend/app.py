import os
import io
import uuid
import json
import time
import shutil
import hashlib
from pathlib import Path
from typing import List, Dict, Any

from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .extractors import LocalPDFExtractor, DocAIExtractor
from .intent import parse_intent
from .search import find_income_by_month, find_client_name, generic_keyword_search

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
INDEX_DIR = BASE_DIR / "data" / "index"
FRONTEND_DIR = BASE_DIR / "frontend"
CACHE_DIR = BASE_DIR / "data" / "cache"

for d in [UPLOAD_DIR, INDEX_DIR, CACHE_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Analyst Doc-Chat PoC")

class ChatPayload(BaseModel):
    message: str

@app.get("/api/health")
def health():
    return {"status": "ok"}

def _get_extractor():
    mode = os.getenv("EXTRACTOR", "local").lower()
    if mode == "docai":
        pid = os.getenv("GCP_PROCESSOR_ID")
        proj = os.getenv("GCP_PROJECT_ID")
        loc = os.getenv("GCP_LOCATION", "eu")
        if not (pid and proj and loc):
            raise RuntimeError("DocAI extractor selected but GCP env vars are missing.")
        return DocAIExtractor(proj, loc, pid)
    return LocalPDFExtractor()

def _index_path(doc_id: str) -> Path:
    return INDEX_DIR / f"{doc_id}.json"

def _save_index(doc_id: str, meta: Dict[str, Any], extracted: Dict[str, Any]):
    out = {"meta": meta, "extracted": extracted}
    with open(_index_path(doc_id), "w", encoding="utf-8") as f:
        json.dump(out, f)

def _load_index(doc_id: str) -> Dict[str, Any]:
    with open(_index_path(doc_id), "r", encoding="utf-8") as f:
        return json.load(f)

def _list_docs() -> List[Dict[str, Any]]:
    docs = []
    for p in INDEX_DIR.glob("*.json"):
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f)
            docs.append({
                "doc_id": p.stem,
                "name": j["meta"]["filename"],
                "pages": len(j["extracted"]["pages"]),
                "sha256": j["meta"].get("sha256"),
                "uploaded_at": j["meta"].get("uploaded_at")
            })
    # sort newest first by uploaded_at, fallback to name
    docs.sort(key=lambda d: (-(d["uploaded_at"] or 0), d["name"]))
    return docs

@app.post("/api/upload")
async def upload(files: List[UploadFile] = File(...)):
    """
    Upload with de-duplication:
    - compute SHA256 of file content
    - if a document with the same hash already exists, don't re-index; return the existing doc entry
    """
    extractor = _get_extractor()
    ids = []

    # build hash -> (doc_id, name, pages) map from existing index
    existing_by_hash: Dict[str, Dict[str, Any]] = {}
    for p in INDEX_DIR.glob("*.json"):
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f)
        h = j["meta"].get("sha256")
        if h:
            existing_by_hash[h] = {
                "doc_id": j["meta"]["doc_id"],
                "name": j["meta"]["filename"],
                "pages": len(j["extracted"]["pages"])
            }

    for file in files:
        content = await file.read()
        sha256 = hashlib.sha256(content).hexdigest()

        if sha256 in existing_by_hash:
            # return existing instead of duplicating
            ids.append(existing_by_hash[sha256])
            continue

        doc_id = str(uuid.uuid4())[:8]
        dest = UPLOAD_DIR / f"{doc_id}_{file.filename}"
        with open(dest, "wb") as out:
            out.write(content)

        extracted = extractor.extract(str(dest))
        meta = {
            "doc_id": doc_id,
            "filename": file.filename,
            "path": str(dest),
            "sha256": sha256,
            "uploaded_at": time.time(),
        }
        _save_index(doc_id, meta, extracted)
        ids.append({"doc_id": doc_id, "name": file.filename, "pages": len(extracted["pages"])})

    return {"uploaded": ids}

@app.get("/api/docs")
def list_docs():
    return {"docs": _list_docs()}

@app.get("/api/doc/{doc_id}/file")
def get_doc_file(doc_id: str):
    meta = _load_index(doc_id)["meta"]
    return FileResponse(meta["path"], media_type="application/pdf", filename=meta["filename"])

# ---------- Delete a document ----------
@app.delete("/api/doc/{doc_id}")
def delete_doc(doc_id: str):
    idx = _index_path(doc_id)
    if not idx.exists():
        return {"deleted": False, "reason": "not_found"}

    j = _load_index(doc_id)
    # delete PDF file
    try:
        os.remove(j["meta"]["path"])
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # delete cache dir for rendered images (if present)
    shutil.rmtree(CACHE_DIR / doc_id, ignore_errors=True)

    # delete index
    try:
        idx.unlink()
    except FileNotFoundError:
        pass

    return {"deleted": True}

# ---------- Image rendering fallback ----------
@app.get("/api/doc/{doc_id}/manifest")
def doc_manifest(doc_id: str):
    j = _load_index(doc_id)
    pages = j["extracted"]["pages"]
    return {
        "count": len(pages),
        "pages": [{"width": p["width"], "height": p["height"]} for p in pages]
    }

@app.get("/api/doc/{doc_id}/page/{page}.png")
def doc_page_png(doc_id: str, page: int, scale: float = 1.25):
    """Render a given page to PNG (fallback viewer)."""
    j = _load_index(doc_id)
    meta = j["meta"]
    pdf_path = meta["path"]

    if page < 0:
        page = 0
    try:
        import fitz  # PyMuPDF
    except Exception as e:
        return Response(content=f"PyMuPDF not installed: {e}", media_type="text/plain", status_code=500)

    page_cache_dir = CACHE_DIR / doc_id
    page_cache_dir.mkdir(parents=True, exist_ok=True)
    cache_name = page_cache_dir / f"p{page}_s{scale:.2f}.png"
    if cache_name.exists():
        return FileResponse(str(cache_name), media_type="image/png")

    try:
        doc = fitz.open(pdf_path)
        page_obj = doc[page]
        mat = fitz.Matrix(scale, scale)
        pix = page_obj.get_pixmap(matrix=mat, alpha=False)
        png_bytes = pix.tobytes("png")
        doc.close()
    except Exception as e:
        return Response(content=f"Render failed: {e}", media_type="text/plain", status_code=500)

    with open(cache_name, "wb") as f:
        f.write(png_bytes)
    return FileResponse(str(cache_name), media_type="image/png")

# ---------- Chat / search ----------
@app.post("/api/chat")
async def chat(payload: ChatPayload):
    intent = parse_intent(payload.message)
    results = []
    for d in _list_docs():
        j = _load_index(d["doc_id"])
        pages = j["extracted"]["pages"]
        if intent["field"] == "income":
            hits = find_income_by_month(pages, intent["month"])
        elif intent["field"] == "client_name":
            hits = find_client_name(pages)
        elif intent["field"] == "iban":
            hits = generic_keyword_search(pages, ["IBAN"])
        elif intent["field"] == "address":
            hits = generic_keyword_search(pages, ["Address", "Adres"])
        else:
            kws = [w for w in payload.message.split() if len(w) > 2]
            hits = generic_keyword_search(pages, kws)

        if hits:
            results.append({
                "doc_id": d["doc_id"],
                "doc_name": d["name"],
                "total_hits": len(hits),
                "highlights": hits
            })

    order = []
    for r in results:
        for idx, h in enumerate(r["highlights"]):
            order.append({"doc_id": r["doc_id"], "doc_name": r["doc_name"], "page": h["page"], "hit_idx": idx})

    return {"intent": intent, "results": results, "order": order}

# Mount static LAST so /api/* routes aren’t shadowed
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")
