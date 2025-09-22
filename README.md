
# Analyst Doc-Chat PoC (Python + FastAPI)

A minimal, enterprise-looking PoC to **chat over borrower documents** and **highlight answers** right in the PDF viewer.
Focuses on Analyst flow #2: *"talk to the docs"* to correct applications by pulling reliable values from uploaded files.

## What it does
- Upload PDFs (multiple per case)
- Ask questions like:
  - “show me income for May”
  - “show the client's name in all docs”
- The backend parses your question into intent (field + constraints), finds hits across the documents,
  and returns **highlight rectangles (normalized)** for each match.
- The UI uses **PDF.js** to display the documents and draws highlights; you can navigate left/right through hits and across docs.

## Tech choices
- **Backend:** FastAPI, PyMuPDF (local PDF text + bbox), simple rule-based intent parser
- **Optional:** Google Document AI integration stub (useful when you want production OCR + entity extraction + bounding boxes)
- **Frontend:** Plain HTML + JS + PDF.js (no React); clean, enterprise-ish styling

## Quickstart
```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Run server
uvicorn backend.app:app --reload
```

Open http://localhost:8000 in your browser.

### Offline-friendly front-end

The UI now defaults to an **offline mode** so it can run without external CDN access (common in secure enterprise labs):

- PDF viewing automatically falls back to server-rendered images instead of loading PDF.js from a CDN.
- The email "LLM" uses the built-in template generator unless you explicitly allow loading Transformers.js from the network.

To opt back into CDN assets when your environment allows it, either:

1. Click **Enable CDN LLM** inside the "Request re-upload" modal to load Transformers.js (this stores your choice in `localStorage`).
2. Update `window.DocChaseConfig` in `frontend/index.html` to set `enableCdn: true` for `pdf` and/or `transformers`; **or**
3. From the browser console run `localStorage.setItem('docchat:pdfCdn', '1')` and/or `localStorage.setItem('docchat:transformersCdn', '1')`, then refresh.

## Using Google Document AI (optional)
Set these env vars and switch the extractor to `docai` (see `backend/app.py`):
- `GCP_PROJECT_ID`
- `GCP_LOCATION` (e.g., `eu`)
- `GCP_PROCESSOR_ID` (Document AI processor for general docs or invoices, etc.)
Also ensure `GOOGLE_APPLICATION_CREDENTIALS` points to a service account JSON with Document AI access.

## Notes & Assumptions
- This is a PoC with **smart heuristics** for common fields (income by month, client name, IBAN, etc.).
- For robust production-grade extraction, prefer Document AI (or your VLLM pipeline) plugged into the same interface in `extractors.py`.
- All highlight rectangles are **normalized [0..1]** per page, so the front-end can scale accurately.
- You can drop any number of PDFs; the system will search them all.
- No external DB; files and indices are stored under `data/`.

## Folder structure
```
analyst-docchat-poc/
  backend/
    app.py
    extractors.py
    intent.py
    search.py
  frontend/
    index.html
    app.js
    styles.css
  data/
    uploads/     # uploaded PDFs live here
    index/       # extracted JSON indices
  requirements.txt
  README.md
```

## Roadmap ideas
- Plug a small LLM for intent parsing (kept local or API-based), fall back to rules.
- Expand field ontology (employment dates, employer, address, DOB, net/gross).
- Confidence scores + "needs review" flags.
- Multi-lender policy snippets inline (future step).
