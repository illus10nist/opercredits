// In-browser email drafter (no external LLM API).
// Uses Transformers.js (WebGPU/WASM) if available; otherwise falls back to a template.

let generator = null;
let status = 'idle';
let ready = false;

export async function init() {
  if (ready || status === 'loading') return;
  status = 'loading';
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@3.0.0');
    const { pipeline } = mod;
    generator = await pipeline('text2text-generation', 'Xenova/LaMini-Flan-T5-248M', {
      progress_callback: (p) => {
        if (p?.totalBytes) status = `loading ${Math.round((p.currentBytes / p.totalBytes) * 100)}%`;
      },
    });
    ready = true;
    status = 'ready';
  } catch (e) {
    console.warn('Transformers.js load/model init failed; using fallback template.', e);
    status = 'fallback';
  }
}

function buildPrompt({ borrower_name, missing_items, issues, due_date, language, tone }) {
  const items = (missing_items || []).map(i => `- ${i}`).join('\n');
  const corr  = (issues && issues.length) ? `\nNotes on corrections:\n${issues.map(i=>`- ${i}`).join('\n')}` : '';
  const due   = due_date ? `\nDeadline: ${due_date}` : '';
  const sys = `You are an analyst drafting a clear, courteous email to request missing or corrected documents for a loan application.
Keep it concise, use bullet points, specify acceptance criteria, and include a due date if provided.
Avoid legal jargon; be kind but specific. Write in ${language}. Tone: ${tone}.
Return JSON ONLY like: {"subject":"...","body":"..."} — no extra text.`;

  return `${sys}

Borrower: ${borrower_name}

Missing/needed documents:
${items}${corr}${due}

Acceptance criteria (generic):
- Clear scans/photos, full edges visible
- All pages included; details readable
- PDF/JPG/PNG are OK
- If not available, suggest acceptable alternatives

Sign as: The Oper Analyst Team`;
}

function fallbackDraft(p) {
  const subject = `Documents needed for your loan application`;
  const lines = (p.missing_items || []).map(i => `• ${i}`).join('\n');
  const notes = (p.issues || []).map(i => `• ${i}`).join('\n');
  const due   = p.due_date ? `\nDeadline: ${p.due_date}` : '';
  const body =
`Hi ${p.borrower_name || 'Borrower'},

To progress your loan application, could you please share the following:

${lines || '• (list items here)'}

${notes ? `Notes on corrections:\n${notes}\n` : ''}Acceptance criteria:
- Clear scans/photos (no glare), full document edges visible
- All pages included; details readable
- PDF/JPG/PNG are OK
${due}

Thanks in advance,
The Oper Analyst Team`;
  return { subject, body };
}

export async function generateDraft(params) {
  params.missing_items = Array.isArray(params.missing_items) ? params.missing_items : [];
  params.issues = Array.isArray(params.issues) ? params.issues : [];

  if (!ready || !generator) { try { await init(); } catch {} }
  if (!ready || !generator || status === 'fallback') return fallbackDraft(params);

  try {
    const out = await generator(buildPrompt(params), { max_new_tokens: 320, temperature: 0.3 });
    let text = (out?.[0]?.generated_text || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
    const j = JSON.parse(text);
    if (j?.subject && j?.body) return j;
  } catch (e) { console.warn('LLM generation/parse failed; using fallback.', e); }
  return fallbackDraft(params);
}

export function getStatus() { return status; }
export function isReady()   { return ready; }

if (typeof window !== 'undefined') {
  window.DocChaseLLM = { init, generateDraft, getStatus, isReady };
  init().catch(() => {});
}
