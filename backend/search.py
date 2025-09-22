
from typing import List, Dict, Any, Optional
import regex as re
from rapidfuzz import fuzz

AmountRegex = re.compile(r"(?:(?:€|\$|£)?\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)")

MONTH_WORDS = {
    1: ["january", "jan"],
    2: ["february", "feb"],
    3: ["march", "mar"],
    4: ["april", "apr"],
    5: ["may"],
    6: ["june", "jun"],
    7: ["july", "jul"],
    8: ["august", "aug"],
    9: ["september", "sep", "sept"],
    10: ["october", "oct"],
    11: ["november", "nov"],
    12: ["december", "dec"],
}

def _words_to_lines(words: List[Dict[str, Any]], y_tol: float = 0.01) -> List[List[Dict[str, Any]]]:
    """Group words into line-like clusters by y center proximity."""
    rows: List[List[Dict[str, Any]]] = []
    centers = []
    for w in words:
        x0,y0,x1,y1 = w["bbox"]
        centers.append(((y0+y1)/2.0, w))
    centers.sort(key=lambda t: t[0])
    for _, w in centers:
        y_center = (w["bbox"][1]+w["bbox"][3])/2.0
        placed = False
        for row in rows:
            y0,y1 = row[0]["bbox"][1], row[0]["bbox"][3]
            y_center_row = (y0+y1)/2.0
            if abs(y_center - y_center_row) <= y_tol:
                row.append(w)
                placed = True
                break
        if not placed:
            rows.append([w])
    for r in rows:
        r.sort(key=lambda w: w["bbox"][0])
    return rows

def _collect_amounts_near(words: List[Dict[str, Any]], anchor_idx: int, window: int = 6) -> List[int]:
    hits = []
    for i in range(max(0, anchor_idx-window), min(len(words), anchor_idx+window+1)):
        if AmountRegex.fullmatch(words[i]["text"]):
            hits.append(i)
    return hits

def find_income_by_month(pages: List[Dict[str, Any]], month: Optional[int]) -> List[Dict[str, Any]]:
    hits: List[Dict[str, Any]] = []
    month_terms = None
    if month is not None:
        month_terms = MONTH_WORDS.get(month, [])
    income_terms = ["income", "salary", "earnings", "wage", "net", "gross", "loon", "inkomen"]

    for p_idx, p in enumerate(pages):
        words = p["words"]
        line_groups = _words_to_lines(words)
        for line in line_groups:
            texts = [w["text"] for w in line]
            lc = [t.lower() for t in texts]
            month_positions = []
            income_positions = []
            for i, t in enumerate(lc):
                if month_terms and any(mt in t for mt in month_terms):
                    month_positions.append(i)
                if any(fuzz.partial_ratio(t, it) >= 80 for it in income_terms):
                    income_positions.append(i)
            anchors = month_positions or income_positions
            if not anchors:
                continue
            for a in anchors:
                amount_idxs = _collect_amounts_near(line, a, window=6)
                for idx in amount_idxs:
                    amt_word = line[idx]
                    hits.append({
                        "page": p_idx,
                        "rects": [amt_word["bbox"]],
                        "label": f"Amount: {amt_word['text']}",
                        "score": 0.82,
                    })
    return hits

def find_client_name(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Heuristic: look for 'Name' / 'Borrower' / 'Applicant' labels and capture the following tokens."""
    label_terms = ["name", "borrower", "applicant", "client", "customer"]
    hits: List[Dict[str, Any]] = []
    for p_idx, p in enumerate(pages):
        line_groups = _words_to_lines(p["words"])
        for line in line_groups:
            lc = [w["text"].lower() for w in line]
            for i, t in enumerate(lc):
                if any(t.startswith(term) for term in label_terms):
                    captured = []
                    for j in range(i+1, min(i+5, len(line))):
                        token = line[j]["text"]
                        if re.search(r"[,:;/\-]", token):
                            break
                        captured.append((token, line[j]["bbox"]))
                    if captured:
                        rects = [b for (_, b) in captured]
                        label = "Name: " + " ".join(w for (w, _) in captured)
                        hits.append({
                            "page": p_idx,
                            "rects": rects,
                            "label": label,
                            "score": 0.78
                        })
    return hits

def generic_keyword_search(pages: List[Dict[str, Any]], keywords: List[str]) -> List[Dict[str, Any]]:
    hits: List[Dict[str, Any]] = []
    for p_idx, p in enumerate(pages):
        for w in p["words"]:
            if any(kw.lower() in w["text"].lower() for kw in keywords):
                hits.append({
                    "page": p_idx,
                    "rects": [w["bbox"]],
                    "label": f"Matched: {w['text']}",
                    "score": 0.6
                })
    return hits
