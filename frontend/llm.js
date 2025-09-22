// In-browser email drafter (no external LLM API).
// Uses Transformers.js (WebGPU/WASM) if available; otherwise falls back to a template.

let generator = null;
let status = 'idle';
let ready = false;

const globalConfig = typeof window !== 'undefined' ? (window.DocChaseConfig || {}) : {};
const transformersConfig = globalConfig.transformers || {};

function readStoredFlag(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const val = localStorage.getItem(key);
    if (val === '1') return true;
    if (val === '0') return false;
  } catch (e) {}
  return null;
}

const storedTransformersPref = readStoredFlag('docchat:transformersCdn');
const initialTransformersCdn =
  storedTransformersPref !== null
    ? storedTransformersPref
    : (typeof transformersConfig.enableCdn === 'boolean' ? transformersConfig.enableCdn : false);

let useTransformersCdn = initialTransformersCdn;

const builtInTransformerCdn = [
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@3.0.0/dist/transformers.min.js',
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.14.0/dist/transformers.min.js',
  'https://unpkg.com/@xenova/transformers@3.0.0/dist/transformers.min.js?module',
  'https://unpkg.com/@xenova/transformers@2.14.0/dist/transformers.min.js?module'
];

const configuredTransformerCdn = Array.isArray(transformersConfig.cdnUrls) && transformersConfig.cdnUrls.length
  ? transformersConfig.cdnUrls
  : builtInTransformerCdn;

const vendorTransformerPath = transformersConfig.vendorPath;

function computeTransformerUrls() {
  const urls = [];
  if (vendorTransformerPath) urls.push(vendorTransformerPath);
  if (useTransformersCdn) urls.push(...configuredTransformerCdn);
  return urls;
}

function setStatus(next) {
  status = next;
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('docchat:llm-status', { detail: next }));
    } catch (e) {}
  }
}

if (!useTransformersCdn && !vendorTransformerPath) {
  console.info('[DocChat] Transformers CDN disabled; using offline email template. Click "Enable CDN LLM" to opt in.');
}

export async function init(opts = {}) {
  const force = opts.force === true;
  if (!force && (ready || status === 'loading')) return;

  const urls = computeTransformerUrls();
  if (urls.length === 0) {
    generator = null;
    ready = true;
    setStatus(useTransformersCdn ? 'template (no sources)' : 'template (CDN disabled)');
    return;
  }

  ready = false;
  setStatus('loading');
  for (const url of urls) {
    try {
      const mod = await import(url);
      const { pipeline } = mod;
      generator = await pipeline('text2text-generation', 'Xenova/LaMini-Flan-T5-248M', {
        progress_callback: (p) => {
          if (p?.totalBytes) {
            setStatus(`loading ${Math.round((p.currentBytes / p.totalBytes) * 100)}%`);
          }
        },
      });
      ready = true;
      setStatus('ready');
      return;
    } catch (e) {
      console.warn('Transformers.js load/model init failed from', url, e);
    }
  }
  generator = null;
  ready = true;
  setStatus(useTransformersCdn ? 'template (load failed)' : 'template (CDN disabled)');
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
  if (!ready || !generator || status !== 'ready') return fallbackDraft(params);

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

export function isCdnEnabled() { return useTransformersCdn; }
export function canEnableCdn() {
  if (configuredTransformerCdn.length === 0) return false;
  if (!useTransformersCdn) return true;
  return typeof status === 'string' && status.startsWith('template (load failed)');
}

export async function enableCdn() {
  if (useTransformersCdn) {
    if (!ready || !generator) {
      await init({ force: true });
    }
    return;
  }
  useTransformersCdn = true;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('docchat:transformersCdn', '1');
    }
  } catch (e) {}
  generator = null;
  ready = false;
  setStatus('idle');
  await init({ force: true });
}

if (typeof window !== 'undefined') {
  window.DocChaseLLM = {
    init,
    generateDraft,
    getStatus,
    isReady,
    enableCdn,
    isCdnEnabled,
    canEnableCdn,
  };
  init().catch(() => {});
}
