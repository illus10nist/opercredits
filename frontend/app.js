// ------- helpers -------
function qs(sel){ return document.querySelector(sel); }
function ce(tag, cls){ const el = document.createElement(tag); if(cls) el.className = cls; return el; }
function toast(msg){
  const t = ce('div','toast'); t.textContent = msg;
  const host = qs('#toasts') || document.body; host.appendChild(t);
  setTimeout(()=>t.remove(), 2200);
}
function mailtoLink(subject, body, to){
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
async function copyText(s){ try{ await navigator.clipboard.writeText(s); toast('Copied'); }catch{} }

function getStoredFlag(key){
  try{
    const val = localStorage.getItem(key);
    if(val === '1') return true;
    if(val === '0') return false;
  }catch(e){}
  return null;
}

// Optional (PDF.js) — app still works if these fail (image fallback)
const globalConfig = window.DocChaseConfig || {};
const allowPdfCdn = (() => {
  const stored = getStoredFlag('docchat:pdfCdn');
  if(stored !== null) return stored;
  if (globalConfig.pdf && typeof globalConfig.pdf.enableCdn === 'boolean') {
    return globalConfig.pdf.enableCdn;
  }
  return false;
})();

const pdfUrls = [];
if (globalConfig.pdf?.vendorPath) {
  pdfUrls.push(globalConfig.pdf.vendorPath);
}
const defaultPdfCdn = globalConfig.pdf?.cdnUrls || [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.mjs',
  'https://unpkg.com/pdfjs-dist@4.6.82/build/pdf.mjs'
];
if (allowPdfCdn) {
  pdfUrls.push(...defaultPdfCdn);
}

const PDF_URLS = pdfUrls;
const PDF_JS_ENABLED = PDF_URLS.length > 0;
const LOCAL_PDF_WORKER = globalConfig.pdf?.workerPath || '/vendor/pdf.worker.min.mjs';

if (!PDF_JS_ENABLED) {
  console.info('[DocChat] PDF.js disabled; using rendered image fallback.');
}

async function ensurePdfJsReady(){
  if (!PDF_JS_ENABLED) return null;
  if (window.pdfjsLib) return window.pdfjsLib;
  for (const url of PDF_URLS){
    try {
      const lib = await import(url);
      if (lib.GlobalWorkerOptions){
        const worker = url.startsWith('/')
          ? LOCAL_PDF_WORKER
          : url.replace('pdf.mjs', 'pdf.worker.min.mjs');
        lib.GlobalWorkerOptions.workerSrc = worker;
      }
      window.pdfjsLib = lib;
      return lib;
    } catch(e){}
  }
  for (let i=0;i<30;i++){
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise(r=>setTimeout(r,100));
  }
  return null;
}

// ------- state -------
let state = {
  docs: [],
  currentDocId: null,
  currentPDF: null,
  results: null,
  order: [],
  navIndex: -1,
  filter: ''
};

// ------- docs list -------
async function fetchDocs(){
  const res = await fetch('/api/docs');
  const data = await res.json();
  state.docs = data.docs;
  renderDocList();
}

function hitsCountFor(docId){
  if(!state.results) return '0';
  const r = state.results.find(r => r.doc_id === docId);
  return r ? String(r.total_hits) : '0';
}

function renderDocList(){
  const ul = qs('#docList');
  const empty = qs('#emptyDocs');
  ul.innerHTML = '';

  const list = state.docs.filter(d => !state.filter || d.name.toLowerCase().includes(state.filter));
  list.forEach(d => {
    const li = ce('li');
    if(state.currentDocId === d.doc_id) li.classList.add('active');

    // left: title + meta
    const left = ce('div');
    const title = ce('div','doc-title'); title.textContent = d.name;
    const meta = ce('div','doc-meta');
    const pages = ce('span','badge'); pages.textContent = `${d.pages}p`;
    const hits  = ce('span','count'); hits.textContent  = hitsCountFor(d.doc_id);
    meta.appendChild(pages); meta.appendChild(hits);
    left.appendChild(title); left.appendChild(meta);

    // right: actions
    const actions = ce('div','doc-actions');

    const open = ce('button','icon-btn'); open.title = 'Open';
    open.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h11v11M19 5l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    open.onclick = (e)=>{ e.stopPropagation(); openDoc(d.doc_id); };

    const del = ce('button','icon-btn danger'); del.title = 'Delete';
    del.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    del.onclick = async (e)=>{ e.stopPropagation(); await deleteDoc(d.doc_id); };

    actions.appendChild(open);
    actions.appendChild(del);

    li.onclick = ()=> openDoc(d.doc_id);
    li.appendChild(left);
    li.appendChild(actions);
    ul.appendChild(li);
  });

  empty.style.display = list.length ? 'none' : 'block';
}

async function deleteDoc(docId){
  const res = await fetch(`/api/doc/${docId}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.deleted){ toast('Could not delete'); return; }

  if(state.results){ state.results = state.results.filter(r => r.doc_id !== docId); }
  state.order = state.order.filter(o => o.doc_id !== docId);

  if(state.currentDocId === docId){
    state.currentDocId = null;
    qs('#pdfContainer').innerHTML = `
      <div class="placeholder">
        <div class="ph-title">Open a document</div>
        <div class="ph-text">Your highlights will appear directly on the page.</div>
      </div>`;
  }

  await fetchDocs();
  updateHitStatus();
  toast('Document deleted');
}

// ------- viewing (PDF.js preferred, else image fallback) -------
async function openDoc(docId){
  state.currentDocId = docId;
  renderDocList();
  await tryRender(docId);
  drawHighlightsForDoc(docId);
}

async function tryRender(docId){
  const lib = await ensurePdfJsReady();
  if (lib){
    await renderPDFjs(`/api/doc/${docId}/file`);
  } else {
    await renderImages(docId);
  }
}

async function renderPDFjs(url){
  const pdfjsLib = window.pdfjsLib;
  const container = qs('#pdfContainer');
  container.innerHTML = '';
  const loadingTask = pdfjsLib.getDocument(url);
  const pdf = await loadingTask.promise;
  state.currentPDF = pdf;

  for(let i=1; i<=pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.15 });
    const pageDiv = ce('div', 'page');
    const canvas = ce('canvas', 'canvasLayer');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageDiv.appendChild(canvas);

    const hlLayer = ce('div', 'highlightLayer');
    hlLayer.style.width = viewport.width + 'px';
    hlLayer.style.height = viewport.height + 'px';
    hlLayer.dataset.page = i-1;
    pageDiv.appendChild(hlLayer);

    container.appendChild(pageDiv);
    await page.render({ canvasContext: context, viewport }).promise;
  }
}

async function renderImages(docId){
  const container = qs('#pdfContainer');
  container.innerHTML = '';
  state.currentPDF = null;
  const man = await fetch(`/api/doc/${docId}/manifest`).then(r=>r.json());
  const pages = man.pages || [];
  const scale = 1.25;

  for(let i=0; i<pages.length; i++){
    const pageDiv = ce('div', 'page');
    const img = new Image();
    img.className = 'canvasLayer';
    img.alt = `Page ${i+1}`;
    img.src = `/api/doc/${docId}/page/${i}.png?scale=${scale}`;
    pageDiv.appendChild(img);

    const hlLayer = ce('div', 'highlightLayer');
    hlLayer.dataset.page = i;
    pageDiv.appendChild(hlLayer);

    img.onload = () => {
      hlLayer.style.width = img.clientWidth + 'px';
      hlLayer.style.height = img.clientHeight + 'px';
    };

    container.appendChild(pageDiv);
  }
}

// ------- highlights -------
function clearHighlights(){
  document.querySelectorAll('.highlightLayer').forEach(layer => layer.innerHTML='');
}

function drawHighlightsForDoc(docId){
  clearHighlights();
  if(!state.results) return;
  const res = state.results.find(r => r.doc_id === docId);
  if(!res) return;
  res.highlights.forEach(h => {
    const layer = document.querySelector(`.highlightLayer[data-page="${h.page}"]`);
    if(!layer) return;
    h.rects.forEach(r => {
      const [x0,y0,x1,y1] = r;
      const rect = ce('div', 'hl');
      const w = layer.clientWidth, hgt = layer.clientHeight;
      rect.style.left = (x0 * w) + 'px';
      rect.style.top = (y0 * hgt) + 'px';
      rect.style.width = ((x1 - x0) * w) + 'px';
      rect.style.height = ((y1 - y0) * hgt) + 'px';
      layer.appendChild(rect);
    });
  });
}

// ------- results / navigation -------
function updateHitStatus(){
  const prev = qs('#prevHit');
  const next = qs('#nextHit');
  if(!state.order.length){
    qs('#hitStatus').textContent = 'No matches';
    prev.disabled = true; next.disabled = true;
    qs('#matchesMeta').textContent = '—';
    qs('#matchesList').innerHTML = '';
    qs('#emptyMatches').style.display = 'block';
    return;
  }
  const cur = state.order[state.navIndex];
  qs('#hitStatus').textContent = `Match ${state.navIndex+1} / ${state.order.length} • ${cur.doc_name} p.${cur.page+1}`;
  prev.disabled = state.navIndex <= 0;
  next.disabled = state.navIndex >= state.order.length-1;
  renderMatchesList();
}

function renderMatchesList(){
  const list = qs('#matchesList');
  const meta = qs('#matchesMeta');
  list.innerHTML = '';
  let total = state.order.length;
  meta.textContent = `${total} result${total===1?'':'s'}`;
  qs('#emptyMatches').style.display = total ? 'none':'block';
  state.order.forEach((item, i) => {
    const li = ce('li','match');
    if(i === state.navIndex) li.style.outline = '2px solid var(--accent)';
    li.onclick = ()=> goToHit(i);
    li.innerHTML = `
      <div><strong>${item.doc_name}</strong></div>
      <div class="meta">
        <span class="badge">Page ${item.page+1}</span>
        <span class="badge">#${i+1}</span>
      </div>
    `;
    list.appendChild(li);
  });
}

async function goToHit(idx){
  if(!state.order.length) return;
  if(idx < 0) idx = 0;
  if(idx >= state.order.length) idx = state.order.length - 1;
  state.navIndex = idx;

  const target = state.order[idx];
  if(state.currentDocId !== target.doc_id){
    await openDoc(target.doc_id);
  }
  drawHighlightsForDoc(target.doc_id);
  const pageEl = document.querySelector(`.highlightLayer[data-page="${target.page}"]`);
  if(pageEl){
    pageEl.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  updateHitStatus();
}

// ------- chat -------
async function sendChat(){
  const input = qs('#chatInput');
  const q = input.value.trim();
  if(!q) return;
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ message: q })
  });
  const data = await res.json();
  const intentText = `field: ${data.intent.field}${data.intent.month ? ' · month: '+data.intent.month : ''}`;
  qs('.intent-text').textContent = intentText;

  state.results = data.results || [];
  state.order = data.order || [];
  state.navIndex = 0;
  renderDocList();
  if(state.order.length){
    await goToHit(0);
    toast(`Found ${state.order.length} match${state.order.length===1?'':'es'}`);
  } else {
    clearHighlights();
    updateHitStatus();
    toast('No matches found');
  }
}

function clearResults(){
  state.results = null;
  state.order = [];
  state.navIndex = -1;
  clearHighlights();
  updateHitStatus();
  qs('.intent-text').textContent = '—';
  toast('Results cleared');
}

// ------- boot -------
document.addEventListener('DOMContentLoaded', () => {
  fetchDocs();

  const llmStatusEl = qs('#llmStatus');
  const enableLlmBtn = qs('#enableLlmBtn');
  let enablingLlm = false;

  function updateLlmStatus(){
    const llm = window.DocChaseLLM;
    const st = llm?.getStatus?.() || 'idle';
    const stStr = String(st);
    const normalized = stStr.toLowerCase();
    if(llmStatusEl){ llmStatusEl.textContent = `LLM: ${stStr}`; }
    if(enableLlmBtn){
      const canEnable = !!llm?.canEnableCdn?.();
      const shouldShow = canEnable && normalized.startsWith('template');
      enableLlmBtn.hidden = !shouldShow;
      if(!shouldShow){ enablingLlm = false; }
      if(!enablingLlm){
        enableLlmBtn.disabled = false;
        const label = stStr.startsWith('template (load failed)') ? 'Retry CDN LLM' : 'Enable CDN LLM';
        enableLlmBtn.textContent = label;
      }
    }
  }

  if(enableLlmBtn){
    enableLlmBtn.addEventListener('click', async () => {
      if(!window.DocChaseLLM?.enableCdn) return;
      enablingLlm = true;
      enableLlmBtn.disabled = true;
      enableLlmBtn.textContent = 'Enabling…';
      try{
        await window.DocChaseLLM.enableCdn();
        const st = window.DocChaseLLM?.getStatus?.();
        if(st === 'ready'){
          toast('LLM ready (Transformers.js)');
        } else {
          toast('LLM fallback active');
        }
      }catch(err){
        console.error('Enable CDN LLM failed', err);
        toast('Could not enable LLM');
      }finally{
        enablingLlm = false;
        updateLlmStatus();
      }
    });
  }

  window.addEventListener('docchat:llm-status', updateLlmStatus);
  updateLlmStatus();

  // Upload
  const fileInput = qs('#fileInput');
  const uploadBtn = qs('#uploadBtn');
  if (uploadBtn && fileInput){ uploadBtn.addEventListener('click', ()=> fileInput.click()); }
  if (fileInput){
    fileInput.addEventListener('change', async (e) => {
      const fd = new FormData();
      [...e.target.files].forEach(f => fd.append('files', f));
      const res = await fetch('/api/upload', { method:'POST', body: fd });
      const data = await res.json();
      await fetchDocs();
      if(data.uploaded?.length){
        openDoc(data.uploaded[0].doc_id);
        toast(`Uploaded ${data.uploaded.length} file${data.uploaded.length===1?'':'s'}`);
      }
      fileInput.value = ""; // reset chooser
    });
  }

  // Chat
  qs('#sendBtn').addEventListener('click', sendChat);
  qs('#chatInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendChat(); });

  // Suggestions
  qs('#suggestions').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if(!chip) return;
    qs('#chatInput').value = chip.textContent;
    sendChat();
  });

  // Filter
  qs('#docSearch').addEventListener('input', (e)=>{
    state.filter = e.target.value.trim().toLowerCase();
    renderDocList();
  });

  // Nav
  qs('#prevHit').addEventListener('click', () => goToHit(state.navIndex - 1));
  qs('#nextHit').addEventListener('click', () => goToHit(state.navIndex + 1));

  // Clear results
  qs('#clearResults').addEventListener('click', clearResults);

  // Theme
  const themeToggle = qs('#themeToggle');
  if (themeToggle){ themeToggle.addEventListener('click', ()=> document.documentElement.classList.toggle('light')); }

  // ------- LLM Doc Re-request modal -------
  const modal = qs('#reuploadModal');
  qs('#requestBtn').addEventListener('click', () => {
    modal.classList.remove('hidden');
    updateLlmStatus();
  });
  qs('#closeModal').addEventListener('click', () => modal.classList.add('hidden'));

  qs('#draftBtn').addEventListener('click', async () => {
    const params = {
      borrower_name: qs('#r_name').value.trim() || 'Borrower',
      borrower_email: qs('#r_email').value.trim() || 'borrower@example.com',
      missing_items: qs('#r_missing').value.split('\n').map(s=>s.trim()).filter(Boolean),
      issues: qs('#r_issues').value.split('\n').map(s=>s.trim()).filter(Boolean),
      due_date: qs('#r_due').value.trim() || null,
      language: qs('#r_lang').value,
      tone: qs('#r_tone').value
    };
    updateLlmStatus();
    const draft = await window.DocChaseLLM.generateDraft(params);
    qs('#out_subject').value = draft.subject || '';
    qs('#out_body').value = draft.body || '';
  });

  qs('#copySub').addEventListener('click', () => copyText(qs('#out_subject').value));
  qs('#copyBody').addEventListener('click', () => copyText(qs('#out_body').value));
  qs('#openMail').addEventListener('click', () => {
    const to = qs('#r_email').value.trim() || '';
    const subject = qs('#out_subject').value;
    const body = qs('#out_body').value;
    if (!to || !subject || !body) { toast('Fill email + generate draft'); return; }
    window.location.href = mailtoLink(subject, body, to);
  });
});
