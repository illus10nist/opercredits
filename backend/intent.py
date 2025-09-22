
import regex as re
from typing import Optional, Dict

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12
}

def parse_intent(q: str) -> Dict:
    """Very lightweight intent parser.
    Returns a dict with keys:
      - task: 'FIND_FIELD'
      - field: 'income'|'client_name'|'iban'|'address'|...
      - month: Optional[int]
      - cross_docs: bool
    """
    s = q.strip().lower()
    month = _extract_month(s)
    cross_docs = "all docs" in s or "all documents" in s or "every document" in s

    # FIELD detection
    if any(w in s for w in ["income", "salary", "earnings", "pay"]):
        field = "income"
    elif "name" in s and any(w in s for w in ["client", "borrower", "applicant", "customer"]):
        field = "client_name"
    elif "iban" in s:
        field = "iban"
    elif "address" in s:
        field = "address"
    else:
        field = "generic"  # fallback: keyword search

    return {
        "task": "FIND_FIELD",
        "field": field,
        "month": month,
        "cross_docs": cross_docs,
        "raw": q,
    }

def _extract_month(s: str) -> Optional[int]:
    for name, idx in MONTHS.items():
        if re.search(rf"\b{name}\b", s):
            return idx
    return None
