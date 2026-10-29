/* Internetová výpůjční služba oscilotoskopu

 * Klientská část pro Google Apps Script HTML Service; společný stav je uložen v Google Sheets.

 */

(() => {

'use strict';

/* =====================================================================

 *  NASTAVENÍ

 * ===================================================================== */

const CONFIG = {

  EMAIL: 'vlcr.hlavni@gmail.com', // e-mail pro upozornění administrátora

  // Platná členská čísla se ověřují na serveru podle evidence členů v Google Sheets.

  MAX_DAYS: 28,                    // maximální délka výpůjčky

  SEND_MIN_MS: 5000,               // minimální doba zobrazení průběhu odesílání

};

const PURPOSE = {
  projekty: 'Zájmová aktivita, osobní projekty',
  vyuka: 'Výuka a vzdělávání',
  oprava: 'Oprava elektroniky',
  jine: 'Jiné'
};
const PICKUP = { osobne: 'Osobně' };
const INSURANCE = { zakladni: 'Bez pojištění' };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = iso => new Date(iso).toLocaleDateString('cs-CZ');
const fmtDT = iso => new Date(iso).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });


const emptyDb = () => ({
  borrowed: false, member: null, from: null, until: null, purpose: '',
  activeRequestId: null, pending: false, pendingForMe: false, log: []
});

let db = emptyDb();
let session = null;   // { role: 'member', member } nebo { role: 'admin' }
let adminToken = null;
let view = 'login';
let wiz = null;       // { step, d }

function normalizeDb(value) {
  const x = value && typeof value === 'object' ? value : {};
  return { ...emptyDb(), ...x, log: Array.isArray(x.log) ? x.log : [] };
}

/*
 * GitHub Pages ↔ Google Apps Script RPC bridge.
 * Ordinary fetch() is blocked by Apps Script's cross-origin response policy.
 * An ordinary HTML form POST navigates a hidden iframe; the response page
 * posts its result to the allow-listed top-level origin via postMessage.
 */
const RPC_TIMEOUT_MS = 60000;
const RPC_MESSAGE_TYPE = 'oscilotoskop-rpc-response';
const rpcPending = new Map();
let rpcClientToken = null;
let rpcBootstrapPromise = null;
let rpcFrameCounter = 0;

function makeRpcId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function validateApiUrl() {
  const value = String(window.OSCI_API_URL || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(value)) {
    throw new Error('Nejdříve nastav URL Google Apps Scriptu v souboru config.js (musí končit /exec).');
  }
  return value;
}

window.addEventListener('message', event => {
  const data = event && event.data;
  if (!data || data.type !== RPC_MESSAGE_TYPE || typeof data.id !== 'string') return;
  const pending = rpcPending.get(data.id);
  if (!pending) return;
  rpcPending.delete(data.id);
  clearTimeout(pending.timeout);
  pending.cleanup();
  if (data.ok) pending.resolve(data.result);
  else pending.reject(new Error(data.error || 'Server vrátil neznámou chybu.'));
});

function rpcRaw(method, args, clientToken) {
  return new Promise((resolve, reject) => {
    let apiUrl;
    try { apiUrl = validateApiUrl(); }
    catch (error) { reject(error); return; }

    const id = makeRpcId();
    const frameName = 'osci_rpc_frame_' + (++rpcFrameCounter) + '_' + id.replace(/[^a-zA-Z0-9_]/g, '');
    const frame = document.createElement('iframe');
    frame.name = frameName;
    frame.title = 'Komunikační spojení se serverem';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;';

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = apiUrl;
    form.target = frameName;
    form.acceptCharset = 'UTF-8';
    form.style.display = 'none';

    const fields = {
      rpc: '1', requestId: id, origin: window.location.origin,
      method: method, args: JSON.stringify(args || []), clientToken: clientToken || ''
    };
    Object.entries(fields).forEach(([key, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = key; input.value = value;
      form.appendChild(input);
    });

    const cleanup = () => {
      form.remove();
      // Allow the response document to finish dispatching its message first.
      window.setTimeout(() => frame.remove(), 50);
    };
    const timeout = window.setTimeout(() => {
      if (!rpcPending.has(id)) return;
      rpcPending.delete(id);
      cleanup();
      reject(new Error('Server neodpověděl v časovém limitu. Zkontrolujte nasazení Apps Scriptu a povolenou doménu webu.'));
    }, RPC_TIMEOUT_MS);
    rpcPending.set(id, { resolve, reject, cleanup, timeout });

    document.body.appendChild(frame);
    document.body.appendChild(form);
    form.submit();
  });
}

function api(method, ...args) {
  if (method === '__bootstrap') return rpcRaw('__bootstrap', [], '');
  if (!rpcClientToken) {
    if (!rpcBootstrapPromise) {
      rpcBootstrapPromise = rpcRaw('__bootstrap', [], '').then(result => {
        if (!result || !result.clientToken) throw new Error('Server neposkytl bezpečnostní token.');
        rpcClientToken = result.clientToken;
        return rpcClientToken;
      }).finally(() => { rpcBootstrapPromise = null; });
    }
    return rpcBootstrapPromise.then(token => rpcRaw(method, args, token));
  }
  return rpcRaw(method, args, rpcClientToken).catch(error => {
    if (/bezpečnostní token|token webu vypršel/i.test(error.message || '')) rpcClientToken = null;
    throw error;
  });
}

function dateInputValue(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statusLabel(state = db) {
  return state.borrowed ? 'vypůjčen' : state.pending ? 'čeká na schválení' : 'dostupný';
}

const content = $('#win-content');

const setStatus = (l, r = '') => { $('#st-left').textContent = l; $('#st-right').textContent = r; };

const deviceState = () => `Oscilotoskop: ${statusLabel()}`;

/* =====================================================================

 *  DIALOGY

 * ===================================================================== */

function dialog({ title = 'Výpůjční služba', type = 'info', text = '', html, buttons = [{ label: 'OK' }], width }) {

  return new Promise(resolve => {

    const ov = document.createElement('div');

    ov.className = 'overlay';

    ov.innerHTML = `

      <div class="window dialog" role="alertdialog" aria-modal="true" ${width ? `style="width:${width}px"` : ''}>

        <div class="titlebar"><span class="tt">${esc(title)}</span>

          <span class="tbtns"><button class="tbtn close" data-i="-1" aria-label="Zavřít"><i class="g-x"></i></button></span></div>

        <div class="dlg-body"><div class="mi mi-${type}"></div>

          <div class="dlg-text">${html ?? esc(text).replace(/\n/g, '<br>')}</div></div>

        <div class="dlg-btns">${buttons.map((b, i) =>

          `<button class="btn${i === 0 ? ' default' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>

      </div>`;

    $('#modal-root').appendChild(ov);

    const close = i => { ov.remove(); resolve(i); };

    ov.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) close(+b.dataset.i); });

    ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(-1); });

    ov.querySelector('.btn').focus();

  });

}

const msg = (text, type = 'info', title) => dialog({ text, type, title });

function progressOverlay() {

  const ov = document.createElement('div');

  ov.className = 'overlay';

  ov.innerHTML = `

    <div class="window dialog" style="width:min(420px,94vw)" role="alertdialog" aria-modal="true">

      <div class="titlebar"><span class="tt">Odesílání žádosti</span></div>

      <div class="dlg-body" style="flex-direction:column;align-items:stretch">

        <div id="pg-text">Příprava zprávy…</div>

        <div class="progress"><div class="bar" id="pg-bar"></div></div>

      </div>

    </div>`;

  $('#modal-root').appendChild(ov);

  const bar = $('#pg-bar', ov), text = $('#pg-text', ov);

  const phases = [

    'Příprava zprávy…',

    'Ověřování členského čísla…',

    'Kontrola zadaných údajů…',

    'Ukládání žádosti do sdílené evidence…',

    'Čekání na odpověď serveru…',

    'Dokončování…',

  ];

  return {

    run(ms) {

      return new Promise(res => {

        const t0 = performance.now();

        const tick = () => {

          const p = Math.min(1, (performance.now() - t0) / ms);

          bar.style.width = (p * 100) + '%';

          text.textContent = phases[Math.min(phases.length - 1, Math.floor(p * phases.length))];

          p < 1 ? requestAnimationFrame(tick) : res();

        };

        tick();

      });

    },

    close() { ov.remove(); },

  };

}

/* =====================================================================

 *  OSCILOSKOP (canvas)

 * ===================================================================== */

function startScope(canvas, live) {

  if (!canvas) return;

  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let t = 0;

  (function frame() {

    if (!document.body.contains(canvas)) return;

    ctx.fillStyle = '#021a02'; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#0d4a0d'; ctx.lineWidth = 1; ctx.beginPath();

    for (let i = 1; i < 8; i++) { const x = Math.round(W * i / 8) + .5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }

    for (let j = 1; j < 6; j++) { const y = Math.round(H * j / 6) + .5; ctx.moveTo(0, y); ctx.lineTo(W, y); }

    ctx.stroke();

    ctx.strokeStyle = live ? '#4dff4d' : '#b8860b'; ctx.lineWidth = 2; ctx.beginPath();

    for (let x = 0; x <= W; x += 2) {

      const y = H / 2 + (live ? Math.sin((x + t) / (W / 6)) * H * 0.28 * (0.8 + 0.2 * Math.sin(t / 40)) : 0);

      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);

    }

    ctx.stroke();

    if (!live) { ctx.fillStyle = '#b8860b'; ctx.font = 'bold 11px monospace'; ctx.fillText('NO SIGNAL', 6, 14); }

    t += 2;

    if (!still) requestAnimationFrame(frame);

  })();

}

/* =====================================================================

 *  PŘIHLÁŠENÍ

 * ===================================================================== */

let adminDataCache = null;

function adminStatusText(status) {
  return ({ pending: 'Čeká na schválení', approved: 'Schváleno', rejected: 'Zamítnuto', returned: 'Vráceno' })[status] || String(status || '—');
}

function adminDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : fmtDT(date);
}

function renderAdmin(data) {
  view = 'admin'; wiz = null;
  adminDataCache = data;
  db = normalizeDb(data.state);
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const pending = requests.filter(request => request.status === 'pending');
  const recent = requests.slice(0, 8);
  const state = db;
  const currentLoanHtml = state.borrowed ? `
    <p>Aktivní výpůjčka: <b>člen č. ${esc(state.member)}</b></p>
    <p>Účel: ${esc(state.purpose || '—')}</p>
    <div class="row admin-date-row">
      <label for="admin-from">Začátek: <input type="date" id="admin-from" value="${esc(dateInputValue(state.from))}"></label>
      <label for="admin-until">Konec: <input type="date" id="admin-until" value="${esc(dateInputValue(state.until))}"></label>
    </div>
    <div class="btnrow">
      <button class="btn default" id="admin-save-dates">Uložit termín</button>
      <button class="btn" id="admin-return">Označit jako vrácený</button>
    </div>` : '<p>Není evidována žádná aktivní výpůjčka.</p>';

  const pendingHtml = pending.length ? pending.map(request => {
    const fields = request.fields || {};
    return `
      <fieldset class="admin-request">
        <legend>Člen č. ${esc(request.member)} · ${esc(adminDateTime(request.createdAt))}</legend>
        <p><b>Účel:</b> ${esc(request.purpose || '—')}</p>
        <p><b>Požadovaný termín:</b> ${esc(fmt(request.requestedFrom))} – ${esc(fmt(request.requestedUntil))}</p>
        <p><b>Telefon:</b> ${esc(fields['Telefon'] || 'neuveden')}</p>
        <p><b>Doba:</b> ${esc(fields['Doba (dní)'] || '—')} dní · <b>Převzetí:</b> ${esc(fields['Převzetí'] || '—')}</p>
        <p><b>Upřesnění:</b> ${esc(fields['Upřesnění'] || '—')}</p>
        <p><b>Zdůvodnění:</b> ${esc(fields['Zdůvodnění'] || '—')}</p>
        <div class="row admin-date-row">
          <label for="approve-from-${esc(request.id)}">Začátek výpůjčky: <input type="date" id="approve-from-${esc(request.id)}" value="${esc(dateInputValue(request.requestedFrom))}"></label>
          <label for="approve-until-${esc(request.id)}">Konec výpůjčky: <input type="date" id="approve-until-${esc(request.id)}" value="${esc(dateInputValue(request.requestedUntil))}"></label>
        </div>
        <div class="btnrow">
          <button class="btn default" data-approve="${esc(request.id)}">Schválit a nastavit výpůjčku</button>
          <button class="btn" data-reject="${esc(request.id)}">Zamítnout žádost</button>
        </div>
      </fieldset>`;
  }).join('') : '<div class="empty">Žádné nevyřízené žádosti.</div>';

  const recentHtml = recent.length ? `
    <div class="lvwrap"><table class="lv">
      <thead><tr><th>Člen</th><th>Vytvořeno</th><th>Stav</th><th>Termín</th></tr></thead><tbody>
      ${recent.map(request => `<tr><td>${esc(request.member)}</td><td>${esc(adminDateTime(request.createdAt))}</td><td>${esc(adminStatusText(request.status))}</td><td>${request.approvedFrom ? `${esc(fmt(request.approvedFrom))} – ${esc(fmt(request.approvedUntil))}` : `${esc(fmt(request.requestedFrom))} – ${esc(fmt(request.requestedUntil))}`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Zatím nebyla podána žádná žádost.</div>';

  content.innerHTML = `
    <div class="userbar">Přihlášen: <b>administrátor</b> <span class="hint">· správa výpůjček</span></div>
    <fieldset>
      <legend>Aktuální výpůjčka</legend>
      ${currentLoanHtml}
    </fieldset>
    <fieldset>
      <legend>Žádosti čekající na schválení (${pending.length})</legend>
      ${pendingHtml}
    </fieldset>
    <fieldset class="hist">
      <legend>Poslední žádosti</legend>
      ${recentHtml}
    </fieldset>
    <div class="btnrow">
      <button class="btn default" id="admin-refresh">Obnovit přehled</button>
      <button class="btn" id="admin-logout">Odhlásit</button>
    </div>`;

  const refreshButton = $('#admin-refresh');
  if (refreshButton) refreshButton.onclick = refreshAdmin;
  $('#admin-logout').onclick = renderLogin;

  const saveDatesButton = $('#admin-save-dates');
  if (saveDatesButton) saveDatesButton.onclick = async () => {
    const from = $('#admin-from').value;
    const until = $('#admin-until').value;
    try {
      await api('updateActiveLoanDates', adminToken, from, until);
      await msg('Termín aktivní výpůjčky byl aktualizován.');
      await refreshAdmin();
    } catch (error) { await msg(error.message || 'Termín se nepodařilo uložit.', 'error', 'Chyba'); }
  };

  const adminReturnButton = $('#admin-return');
  if (adminReturnButton) adminReturnButton.onclick = async () => {
    const answer = await dialog({
      type: 'question', title: 'Uzavření výpůjčky',
      text: 'Opravdu chcete označit aktuální výpůjčku jako vrácenou?',
      buttons: [{ label: 'Ano' }, { label: 'Ne' }]
    });
    if (answer !== 0) return;
    try {
      await api('adminReturnLoan', adminToken);
      await msg('Výpůjčka byla uzavřena a přístroj je opět dostupný.');
      await refreshAdmin();
    } catch (error) { await msg(error.message || 'Výpůjčku se nepodařilo uzavřít.', 'error', 'Chyba'); }
  };

  $$('[data-approve]', content).forEach(button => {
    button.onclick = async () => {
      const id = button.dataset.approve;
      const from = $(`#approve-from-${id}`, content).value;
      const until = $(`#approve-until-${id}`, content).value;
      if (!from || !until) { await msg('Vyberte začátek a konec výpůjčky.', 'warn'); return; }
      const answer = await dialog({
        type: 'question', title: 'Schválit žádost',
        text: `Schválit žádost člena č. ${button.closest('fieldset').querySelector('legend').textContent.match(/\d{4}/)?.[0] || ''} na termín ${from} až ${until}?`,
        buttons: [{ label: 'Schválit' }, { label: 'Zpět' }]
      });
      if (answer !== 0) return;
      try {
        await api('approveLoanRequest', adminToken, id, from, until);
        await msg('Žádost byla schválena a termín výpůjčky uložen.');
        await refreshAdmin();
      } catch (error) { await msg(error.message || 'Žádost se nepodařilo schválit.', 'error', 'Chyba'); }
    };
  });

  $$('[data-reject]', content).forEach(button => {
    button.onclick = async () => {
      const answer = await dialog({
        type: 'question', title: 'Zamítnout žádost',
        text: 'Opravdu chcete žádost zamítnout? Přístroj se pak může stát dostupným pro novou žádost.',
        buttons: [{ label: 'Zamítnout' }, { label: 'Zpět' }]
      });
      if (answer !== 0) return;
      try {
        await api('rejectLoanRequest', adminToken, button.dataset.reject, 'Zamítnuto administrátorem.');
        await msg('Žádost byla zamítnuta.');
        await refreshAdmin();
      } catch (error) { await msg(error.message || 'Žádost se nepodařilo zamítnout.', 'error', 'Chyba'); }
    };
  });

  setStatus('Administrátorská správa', deviceState());
}

async function refreshAdmin() {
  try {
    const data = await api('getAdminData', adminToken);
    renderAdmin(data);
  } catch (error) {
    await msg(error.message || 'Administrátorská data se nepodařilo načíst.', 'error', 'Chyba');
    if (/relace|přihlaste/i.test(error.message || '')) renderLogin();
  }
}

/* =====================================================================
 *  EVIDENCE ČLENŮ (Google Sheets → CSV)
 *  Sloupce: A = Jméno a příjmení, B = ID, C = e-mail, D = telefon, E = Zaměření
 * ===================================================================== */
let membersCache = null;

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const normId = v => { const d = String(v ?? '').replace(/\D/g, ''); return d ? ('0000' + d).slice(-4) : ''; };

async function loadMembers() {
  if (membersCache) return membersCache;
  const url = String(window.OSCI_MEMBERS_CSV_URL || '').trim();
  if (!url) throw new Error('V souboru config.js chybí adresa OSCI_MEMBERS_CSV_URL.');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Evidenci členů se nepodařilo načíst (HTTP ' + res.status + ').');
  const rows = parseCsv(await res.text());
  const map = new Map();
  rows.slice(1).forEach(r => {
    const id = normId(r[1]), name = String(r[0] || '').trim();
    if (id && name) map.set(id, name);
  });
  if (!map.size) throw new Error('Evidence členů je prázdná nebo má jiný formát.');
  membersCache = map;
  return map;
}

function renderLogin() {
  view = 'login'; session = null; adminToken = null; wiz = null;
  content.innerHTML = `
    <div class="login">
      <div class="login-hero">
        <div>
          <h1>Internetová výpůjční služba oscilotoskopu</h1>
          <p>Přihlaste se čtyřmístným členským číslem. Administrátor použije své přidělené číslo.</p>
        </div>
      </div>
      <fieldset>
        <legend>Přihlášení</legend>
        <label for="member">Členské / administrátorské číslo:</label>
        <div class="row">
          <input type="text" id="member" inputmode="numeric" maxlength="4" autocomplete="off" aria-describedby="login-help">
        </div>
        <div id="login-help" class="hint">Zadejte své čtyřmístné členské číslo z evidence členů.</div>
      </fieldset>
      <div class="btnrow">
        <button class="btn default" id="login-ok">OK</button>
        <button class="btn" id="login-clear">Vymazat</button>
      </div>
    </div>`;

  const input = $('#member');
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });
  const go = async () => {
    const v = input.value.trim();
    if (!/^\d{4}$/.test(v)) {
      await msg('Zadejte čtyřmístné číslo.', 'error', 'Přihlášení se nezdařilo');
      input.focus(); input.select();
      return;
    }
    $('#login-ok').disabled = true;
    try {
      const [auth, members] = await Promise.all([
        api('loginUser', v),
        loadMembers().catch(error => ({ error }))
      ]);
      if (auth.role !== 'admin') {
        if (members.error) throw members.error;
        if (!members.has(normId(auth.member || v))) throw new Error('Toto členské číslo není v evidenci členů.');
      }
      if (auth.role === 'admin') {
        adminToken = auth.token;
        session = { role: 'admin' };
        const data = await api('getAdminData', adminToken);
        db = normalizeDb(data.state);
        renderAdmin(data);
      } else {
        session = { role: 'member', member: auth.member, name: members.get(normId(auth.member || v)) };
        db = normalizeDb(await api('getPublicState', auth.member));
        renderMain();
      }
    } catch (error) {
      session = null; adminToken = null;
      await msg(error.message || 'Přihlášení se nezdařilo.', 'error', 'Přihlášení se nezdařilo');
      const currentInput = $('#member');
      if (currentInput) { currentInput.focus(); currentInput.select(); }
    } finally {
      const button = $('#login-ok');
      if (button) button.disabled = false;
    }
  };
  $('#login-ok').onclick = go;
  $('#login-clear').onclick = () => { input.value = ''; input.focus(); };
  input.onkeydown = e => { if (e.key === 'Enter') go(); };
  input.focus();
  setStatus('Přihlášení', deviceState());
}

/* =====================================================================

 *  HLAVNÍ STRÁNKA (stav přístroje)

 * ===================================================================== */

function renderMain() {
  view = 'main'; wiz = null;
  const b = !!db.borrowed;
  const pending = !!db.pending;
  const mine = b && String(db.member) === session.member;
  const hist = (db.log || []).slice(-6).reverse();
  const statusText = b ? 'Vypůjčen' : pending ? 'Čeká na schválení' : 'Dostupný';
  const statusLed = b ? 'red' : pending ? 'amber' : 'green';

  content.innerHTML = `
    <div class="userbar">${session.name ? `Dobrý den, <b>${esc(session.name)}</b>` : 'Dobrý den'} <span class="hint">(člen č. ${esc(session.member)})</span></div>
    <div class="main-grid">
      <fieldset class="dev">
        <legend>Přístroj</legend>
        <div><b>Oscilotoskop</b></div>
      </fieldset>
      <fieldset>
        <legend>Aktuální stav</legend>
        <div class="statline"><span class="led ${statusLed}"></span><b>${statusText}</b></div>
        ${b ? `
          <table class="kv">
            <tr><td>Vypůjčil:</td><td>člen č. ${esc(db.member)}${mine ? ' (vy)' : ''}</td></tr>
            <tr><td>Od:</td><td>${fmt(db.from)}</td></tr>
            <tr><td>Do:</td><td>${fmt(db.until)}</td></tr>
            <tr><td>Účel:</td><td>${esc(db.purpose)}</td></tr>
          </table>` : pending ? `
          <p>${db.pendingForMe ? 'Vaše žádost čeká na schválení administrátorem.' : 'Žádost o výpůjčku čeká na schválení administrátorem.'} Přístroj zatím není vydán.</p>` : `<p>Oscilotoskop je k dispozici. Vypůjčení zahájíte tlačítkem „Vypůjčit oscilotoskop“.</p>`}
      </fieldset>
    </div>
    <fieldset class="hist">
      <legend>Poslední události</legend>
      <div class="lvwrap">${hist.length ? `
        <table class="lv"><thead><tr><th>Kdy</th><th>Událost</th><th>Člen</th></tr></thead><tbody>
        ${hist.map(h => `<tr><td>${fmtDT(h.at)}</td><td>${esc(h.t)}</td><td>${esc(h.member)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Zatím žádné záznamy.</div>'}
      </div>
    </fieldset>
    <div class="btnrow">
      <button class="btn default" id="m-borrow" ${(b || pending) ? 'disabled' : ''}>Vypůjčit oscilotoskop…</button>
      <button class="btn" id="m-return" ${mine ? '' : 'disabled'}>Vrátit oscilotoskop…</button>
      <button class="btn" id="m-refresh">Obnovit stav</button>
      <button class="btn" id="m-logout">Odhlásit</button>
    </div>`;

  $('#m-borrow').onclick = startWizard;
  $('#m-return').onclick = doReturn;
  $('#m-refresh').onclick = refreshMemberState;
  $('#m-logout').onclick = renderLogin;
  setStatus(`Přihlášen: ${session.name || 'člen č. ' + session.member}`, deviceState());
}

async function refreshMemberState() {
  try {
    db = normalizeDb(await api('getPublicState', session.member));
    renderMain();
  } catch (error) {
    await msg(error.message || 'Sdílený stav se nepodařilo načíst.', 'error', 'Chyba');
  }
}

async function doReturn() {
  const i = await dialog({
    type: 'question', title: 'Vrácení oscilotoskopu',
    text: 'Opravdu chcete označit oscilotoskop jako vrácený? O změně bude informován administrátor.',
    buttons: [{ label: 'Ano' }, { label: 'Ne' }]
  });
  if (i !== 0) return;
  try {
    await api('returnLoan', session.member);
    db = normalizeDb(await api('getPublicState', session.member));
    await msg('Oscilotoskop byl označen jako vrácený.');
    renderMain();
  } catch (error) {
    await msg(error.message || 'Vrácení se nepodařilo uložit.', 'error', 'Chyba');
    await refreshMemberState();
  }
}

/* =====================================================================

 *  PRŮVODCE – OBSAH

 * ===================================================================== */

const radio = (name, opts, cur, extra = '') => opts.map(([v, t]) =>

  `<label class="opt"><input type="radio" name="${name}" value="${v}" data-k="${name}" ${cur === v ? 'checked' : ''} ${extra}><span>${esc(t)}</span></label>`).join('');

const chk = (k, t, on, extra = '') =>

  `<label class="opt"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''} ${extra}><span>${esc(t)}</span></label>`;

const chkArr = (k, v, t, arr) =>

  `<label class="opt"><input type="checkbox" data-k="${k}" data-arr="1" value="${v}" ${arr.includes(v) ? 'checked' : ''}><span>${esc(t)}</span></label>`;

const options = (map, cur) => Object.entries(map).map(([v, t]) =>

  `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(t)}</option>`).join('');

const TREE = [

  { id: 'f1', name: 'Knihovna zařízení', children: [

    { id: 'f2', name: 'Měřicí technika', children: [

      { id: 'l1', name: 'Multimetr' },

      { id: 'f3', name: 'Osciloskopy', children: [

        { id: 'l2', name: 'Oscilotoskop', ok: true } ] },

      { id: 'l3', name: 'Kalibrátor' } ] },

    { id: 'f4', name: 'Příslušenství', children: [

      { id: 'l4', name: 'Měřicí sonda' },

      { id: 'l5', name: 'Laboratorní zdroj' } ] },

    { id: 'f5', name: 'Nářadí', children: [

      { id: 'l6', name: 'Pájecí stanice' },

      { id: 'l7', name: 'Ruční nářadí' } ] },

  ] },

];

const nodeLabel = n => n.name + (n.children || n.ok ? '' : ' (není k dispozici)');

function treeHtml(nodes, d) {

  return '<ul>' + nodes.map(n => {

    if (n.children) {

      const o = !!d.open[n.id];

      return `<li><span class="tg" data-tg="${n.id}">${o ? '−' : '+'}</span><span class="ti ${d.treeSel === n.id ? 'sel' : ''}" data-n="${n.id}"><span class="fold"></span>${esc(n.name)}</span>${o ? treeHtml(n.children, d) : ''}</li>`;

    }

    return `<li><span class="tg none"></span><span class="ti ${d.treeSel === n.id ? 'sel' : ''}" data-n="${n.id}"><span class="leaf"></span>${esc(nodeLabel(n))}</span></li>`;

  }).join('') + '</ul>';

}

const findNode = (nodes, id) => {

  for (const n of nodes) {

    if (n.id === id) return n;

    if (n.children) { const f = findNode(n.children, id); if (f) return f; }

  }

};

const RULES = [

  'Čl. 1 – Oscilotoskop smí být používán výhradně k měření a pozorování elektrických signálů v souladu s jeho určením.',

  'Čl. 2 – Vypůjčitel je povinen zacházet s přístrojem s péčí řádného hospodáře a chránit jej před poškozením, vlhkostí, nárazy a znečištěním.',

  'Čl. 3 – Je zakázáno připojovat přístroj k napětí přesahujícímu hodnoty uvedené výrobcem na přístroji a v jeho dokumentaci.',

  'Čl. 4 – Zemnicí svorku sondy lze připojit pouze na místa, jejichž potenciál vypůjčitel ověřil.',

  'Čl. 5 – Před každým měřením je vypůjčitel povinen zkontrolovat nastavení dělicího poměru sondy (×1 / ×10) a odpovídající nastavení vstupu přístroje.',

  'Čl. 6 – Přístroj nesmí být předán ani zapůjčen třetí osobě.',

  'Čl. 7 – Obrazovku a ovládací prvky je dovoleno čistit pouze měkkým suchým hadříkem.',

  'Čl. 8 – Zjistí-li vypůjčitel na přístroji závadu, je povinen ji neprodleně oznámit provozovateli. Vlastní opravy nejsou dovoleny.',

  'Čl. 9 – Přístroj se vrací čistý, kompletní a ve sjednané době, včetně veškerého příslušenství (sondy, napájecí kabel).',

  'Čl. 10 – Tento provozní řád nabývá účinnosti okamžikem odeslání žádosti o vypůjčení.',

  'Konec provozního řádu. Nyní můžete zvolit, zda s provozním řádem souhlasíte.',

];

const TERMS = [

  'Čl. I – Předmět smlouvy: Půjčitel přenechává vypůjčiteli k bezúplatnému dočasnému užívání přístroj označený jako „Oscilotoskop“ (dále jen „Přístroj“) a vypůjčitel se zavazuje jej ve sjednané době vrátit.',

  'Čl. II – Doba výpůjčky: Výpůjčka vzniká schválením žádosti a zaniká vrácením Přístroje, nejpozději uplynutím doby uvedené v žádosti.',

  'Čl. III – Povinnosti vypůjčitele: Vypůjčitel užívá Přístroj v souladu s provozním řádem a chrání jej před poškozením, ztrátou a zneužitím.',

  'Čl. IV – Odpovědnost za škodu: Vypůjčitel odpovídá za poškození, ztrátu či zničení Přístroje, s výjimkou běžného opotřebení při řádném užívání.',

  'Čl. V – Zákaz podvýpůjčky: Vypůjčitel není oprávněn přenechat Přístroj třetí osobě.',

  'Čl. VI – Osobní údaje: Údaje uvedené v žádosti (členské číslo, telefon, účel výpůjčky) jsou použity pouze k evidenci výpůjčky a jsou odeslány e-mailem na adresu půjčitele.',

  'Čl. VII – Vrácení: Přístroj se vrací ve stavu, v jakém byl převzat, s přihlédnutím k běžnému opotřebení, včetně veškerého příslušenství.',

  'Čl. VIII – Prodloužení: O prodloužení výpůjčky je třeba požádat nejpozději v den skončení výpůjčky prostřednictvím této služby.',

  'Čl. IX – Závěrečná ustanovení: Výpůjčka je sjednána schválením žádosti administrátorem. Vypůjčitel potvrzuje, že se s podmínkami seznámil.',

];

const STEPS = [

  /* Úvodní informace */ {

    title: 'Úvodní informace',

    help: 'Před pokračováním je nutné potvrdit, že jste se s úvodními informacemi seznámili.',

    render: d => `

      <p>Tento formulář slouží k vypůjčení zařízení Oscilotoskop. Postupně zadáte údaje o výpůjčce, seznámíte se s provozním řádem a smluvními podmínkami a žádost odešlete.</p>

      <p>Žádost se uloží do sdílené evidence a administrátor dostane e-mailové upozornění. Výpůjčka vznikne až po schválení administrátorem.</p>

      <p>Před pokračováním si prosím přečtěte tyto informace.</p>

      <fieldset><legend>Potvrzení seznámení s informacemi</legend>

        ${radio('understood', [

          ['a', 'Informace jsem přečetl(a) a rozumím jim'],

          ['b', 'Informace jsem přečetl(a), ale některým částem nerozumím'],

          ['c', 'Informace jsem nečetl(a)']], d.understood)}

      </fieldset>

      <div class="hint" id="h1"></div>`,

    bind(r, d) { this.onModel(r, d); },

    onModel(r, d) {

      const t = {

        a: '',

        b: `Případné dotazy můžete zaslat na adresu ${CONFIG.EMAIL}.`,

        c: 'Doporučujeme informace nejprve přečíst.',

      };

      $('#h1', r).textContent = t[d.understood] || '';

    },

    validate: d => {

      if (!d.understood) return 'Zvolte, zda jste se s informacemi seznámil(a).';

      if (d.understood === 'c') return 'Pro pokračování je nutné se s informacemi seznámit.';

      return null;

    },

  },

  /* Výběr zařízení */ {

    title: 'Výběr zařízení',

    help: 'Rozbalte složky ve stromu, vyberte zařízení Oscilotoskop a přidejte jej do seznamu tlačítkem „Přidat“.',

    render: () => `

      <p>Ve stromu zařízení vyhledejte požadované zařízení. Složky rozbalíte kliknutím na symbol <b>+</b> nebo dvojitým kliknutím na název. Vybrané zařízení přidejte do seznamu tlačítkem <b>Přidat &gt;&gt;</b>.</p>

      <div class="two">

        <div class="col"><div class="lbl">Knihovna zařízení:</div><div class="tree" id="tree"></div></div>

        <div class="mid"><button class="btn" id="t-add">Přidat &gt;&gt;</button><button class="btn" id="t-del">&lt;&lt; Odebrat vše</button></div>

        <div class="col"><div class="lbl">Vybraná zařízení:</div><div class="listbox" id="chosen"></div></div>

      </div>`,

    bind(r, d) {

      const tree = $('#tree', r), chosen = $('#chosen', r);

      const paint = () => {

        tree.innerHTML = treeHtml(TREE, d);

        chosen.innerHTML = d.chosen.map(n => `<div class="li">${esc(n)}</div>`).join('');

      };

      tree.onclick = e => {

        const tg = e.target.closest('[data-tg]');

        if (tg) { d.open[tg.dataset.tg] = !d.open[tg.dataset.tg]; paint(); return; }

        const n = e.target.closest('[data-n]');

        if (n) {

          d.treeSel = n.dataset.n;

          $$('.ti.sel', tree).forEach(x => x.classList.remove('sel'));

          n.classList.add('sel');

        }

      };

      tree.ondblclick = e => {

        const n = e.target.closest('[data-n]');

        if (n && findNode(TREE, n.dataset.n).children) { d.open[n.dataset.n] = !d.open[n.dataset.n]; paint(); }

      };

      $('#t-add', r).onclick = () => {

        const n = d.treeSel && findNode(TREE, d.treeSel);

        if (!n) return msg('Nejprve vyberte položku ve stromu zařízení.');

        if (n.children) return msg(`„${n.name}“ je složka, nikoli zařízení.\nRozbalte ji a vyberte zařízení.`, 'warn');

        if (!n.ok) return msg(`Zařízení „${n.name}“ momentálně není k dispozici.\nK vypůjčení je určen pouze Oscilotoskop.`, 'warn');

        if (d.chosen.includes(n.name)) return msg('Toto zařízení je již v seznamu vybraných zařízení.');

        d.chosen.push(n.name); paint();

      };

      $('#t-del', r).onclick = () => { d.chosen = []; paint(); };

      paint();

    },

    validate: d => d.chosen.includes('Oscilotoskop') ? null : 'Do seznamu vybraných zařízení nebyl přidán Oscilotoskop.',

  },

  /* Účel výpůjčky */ {

    title: 'Účel výpůjčky',

    help: 'Vyberte kategorii účelu, alespoň jedno upřesnění a doplňte zdůvodnění o délce nejméně 50 znaků.',

    render: d => `

      <p>Uveďte, k čemu budete Oscilotoskop používat. Vyplňte všechny údaje.</p>

      <div class="row"><label for="pc">Kategorie účelu:</label>

        <select id="pc" data-k="purposeCat"><option value="">— vyberte —</option>${options(PURPOSE, d.purposeCat)}</select></div>

      <fieldset><legend>Upřesnění účelu (alespoň jedno)</legend>

        ${chkArr('specs', 'napeti', 'Měření napětí', d.specs)}

        ${chkArr('specs', 'frekvence', 'Měření frekvence', d.specs)}

        ${chkArr('specs', 'prubehy', 'Pozorování průběhů signálu', d.specs)}

        ${chkArr('specs', 'seznameni', 'Seznámení s přístrojem', d.specs)}

      </fieldset>

      <div class="lbl"><label for="pt">Podrobné zdůvodnění (nejméně 50 znaků):</label></div>

      <textarea id="pt" rows="3" data-k="purposeText">${esc(d.purposeText)}</textarea>

      <div class="hint" id="cnt"></div>`,

    bind(r, d) { this.onModel(r, d); },

    onModel(r, d) {

      const n = d.purposeText.trim().length;

      $('#cnt', r).textContent = n >= 50 ? '' : `Zbývá znaků: ${50 - n}`;

    },

    validate: d => {

      if (!d.purposeCat) return 'Vyberte kategorii účelu.';

      if (!d.specs.length) return 'Zvolte alespoň jedno upřesnění účelu.';

      if (d.purposeText.trim().length < 50) return 'Zdůvodnění musí mít alespoň 50 znaků.';

      return null;

    },

  },

  /* Doba výpůjčky */ {

    title: 'Doba výpůjčky',

    help: `Zadejte počet týdnů a dnů. Celková doba výpůjčky může být nejvýše ${CONFIG.MAX_DAYS} dní.`,

    render: d => `

      <p>Určete, na jak dlouho si přejete Oscilotoskop vypůjčit. Zadejte počet týdnů a dnů (nejvýše ${CONFIG.MAX_DAYS} dní celkem).</p>

      <div class="row">

        <label>Týdny (0–4): <input type="number" class="num" min="0" max="4" data-k="weeks" value="${esc(d.weeks)}"></label>

        <label>Dny (0–6): <input type="number" class="num" min="0" max="6" data-k="days" value="${esc(d.days)}"></label>

      </div>

      <div class="hint" id="total"></div>

      <fieldset><legend>Začátek výpůjčky</legend>

        ${radio('start', [['ihned', 'Ihned po schválení'], ['zitra', 'Následující den'], ['tyden', 'Za 7 dní']], d.start)}

      </fieldset>`,

    bind(r, d) { this.onModel(r, d); },

    onModel(r, d) {

      const t = (parseInt(d.weeks, 10) || 0) * 7 + (parseInt(d.days, 10) || 0);

      $('#total', r).textContent = `Celková doba: ${t} ${t === 1 ? 'den' : (t >= 2 && t <= 4 ? 'dny' : 'dní')}`;

    },

    validate: d => {

      const w = parseInt(d.weeks, 10), dd = parseInt(d.days, 10);

      if (!(w >= 0 && w <= 4) || !(dd >= 0 && dd <= 6)) return 'Počet týdnů musí být v rozmezí 0–4 a počet dnů v rozmezí 0–6.';

      const t = w * 7 + dd;

      if (t < 1) return 'Doba výpůjčky musí být alespoň 1 den.';

      if (t > CONFIG.MAX_DAYS) return `Maximální doba výpůjčky je ${CONFIG.MAX_DAYS} dní.`;

      if (!d.start) return 'Zvolte začátek výpůjčky.';

      return null;

    },

  },

  /* Bezpečnostní ověření */ {

    title: 'Bezpečnostní ověření',

    help: 'Zaškrtněte všechny položky, které jsou součástí osciloskopu nebo jeho základního vybavení.',

    render: d => `

      <p>Pro ověření základní znalosti přístroje zaškrtněte <b>všechny</b> položky, které jsou součástí osciloskopu nebo jeho základního vybavení.</p>

      <fieldset><legend>Základní vnitřní komponenty osciloskopu</legend>

          ${chkArr('quiz', 'vert_amp', 'Vertikální zesilovač s proměnným zesílením a přepínatelnou vstupní impedancí', d.quiz)}

          ${chkArr('quiz', 'fake_flux', 'Kvantový fluxový dekompresor katodového paprsku', d.quiz)}

          ${chkArr('quiz', 'trigger_hold', 'Obvod pro nastavení mrtvé doby spouštění (Trigger Holdoff)', d.quiz)}

          ${chkArr('quiz', 'fake_demag', 'Inverzní fázový demagnetizér vertikální deflekční cívky', d.quiz)}

          ${chkArr('quiz', 'adc_interleave', 'Interleaving multiplexer vysokorychlostních A/D převodníků', d.quiz)}

          ${chkArr('quiz', 'fake_resonator', 'Subharmonický rezonátor luminoforové vrstvy', d.quiz)}

          ${chkArr('quiz', 'timebase_pll', 'Fázově závěsná smyčka (PLL) časové základny s nízkým fázovým šumem', d.quiz)}

      </fieldset>`,

    validate: d => {

      const ok = ['vert_amp', 'trigger_hold', 'adc_interleave', 'timebase_pll'];

      return ok.length === d.quiz.length && ok.every(x => d.quiz.includes(x))

        ? null : 'Odpověď není správná. Zkontrolujte vybrané položky a zkuste to znovu.';

    },

  },

  /* Provozní řád */ {

    title: 'Provozní řád',

    help: 'Posuňte text provozního řádu až na konec. Poté bude možné zvolit souhlas.',

    render: d => `

      <p>Přečtěte si provozní řád. Volba souhlasu bude zpřístupněna po posunutí textu až na konec.</p>

      <div class="scrollbox" tabindex="0" aria-label="Provozní řád">${RULES.map(t => `<p>${esc(t)}</p>`).join('')}</div>

      <fieldset><legend>Souhlas s provozním řádem</legend>

        ${radio('rules', [['ano', 'Souhlasím s provozním řádem'], ['ne', 'Nesouhlasím s provozním řádem']], d.rules, d.rulesScrolled ? '' : 'disabled')}

      </fieldset>

      <div class="hint" id="sc-hint">${d.rulesScrolled ? 'Text byl dočten. Nyní můžete zvolit souhlas.' : 'Posuňte text až na konec.'}</div>`,

    bind(r, d) {

      const box = $('.scrollbox', r);

      box.addEventListener('scroll', () => {

        if (!d.rulesScrolled && box.scrollTop + box.clientHeight >= box.scrollHeight - 3) {

          d.rulesScrolled = true;

          $$('input[data-k="rules"]', r).forEach(i => { i.disabled = false; });

          $('#sc-hint', r).textContent = 'Text byl dočten. Nyní můžete zvolit souhlas.';

        }

      });

    },

    validate: d => {

      if (!d.rulesScrolled) return 'Provozní řád nebyl dočten až do konce.';

      if (d.rules === 'ne') return 'Bez souhlasu s provozním řádem nelze výpůjčku dokončit.';

      return d.rules === 'ano' ? null : 'Zvolte, zda s provozním řádem souhlasíte.';

    },

  },

  /* Převzetí, kontakt a pojištění */ {

    title: 'Převzetí, kontakt a pojištění',

    help: 'Vyplňte všechny tři karty: způsob převzetí, kontaktní telefon a pojištění.',

    redraw: true,

    render: d => {

      const tabs = ['Převzetí', 'Kontakt', 'Pojištění'];

      const panels = [

        `<p>Zvolte způsob převzetí Oscilotoskopu.</p>

         ${radio('pickup', Object.entries(PICKUP), d.pickup)}

         <p class="hint">Termín převzetí bude dohodnut s provozovatelem po schválení žádosti.</p>`,

        `<p>Uveďte telefonní číslo, na kterém vás můžeme kontaktovat.</p>

         <div class="row"><label for="ph">Telefon:</label>

         <input type="text" id="ph" inputmode="tel" data-k="phone" value="${esc(d.phone)}" placeholder="+420 123 456 789"></div>`,

        `<p>Zvolte rozsah pojištění zařízení.</p>

         <div class="row"><label for="ins">Rozsah pojištění:</label>

         <select id="ins" data-k="insurance"><option value="">— vyberte —</option>${options(INSURANCE, d.insurance)}</select></div>

         ${chk('insuranceOk', 'Beru na vědomí, že výpůjčka není pojištěna a že za škodu odpovídám podle smluvních podmínek', d.insuranceOk)}`,

      ];

      return `<p>Vyplňte všechny tři karty.</p>

        <div class="tabs" role="tablist">${tabs.map((t, i) =>

          `<button type="button" role="tab" class="tab ${d.tab === i ? 'on' : ''}" data-tab="${i}" aria-selected="${d.tab === i}">${t}</button>`).join('')}</div>

        <div class="tabpanel" role="tabpanel">${panels[d.tab]}</div>`;

    },

    bind(r, d, redraw) {

      r.onclick = e => {

        const t = e.target.closest('[data-tab]');

        if (t) { d.tab = +t.dataset.tab; redraw(); }

      };

    },

    validate: d => {

      if (!d.pickup) { d.tab = 0; return 'Na kartě „Převzetí“ zvolte způsob převzetí.'; }

      if (!/^(?:\+420)?[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}$/.test(d.phone.trim())) { d.tab = 1; return 'Na kartě „Kontakt“ zadejte platné telefonní číslo (9 číslic, volitelně s předvolbou +420).'; }

      if (!d.insurance) { d.tab = 2; return 'Na kartě „Pojištění“ vyberte rozsah pojištění.'; }

      if (!d.insuranceOk) { d.tab = 2; return 'Na kartě „Pojištění“ je třeba potvrdit, že jste vzal(a) na vědomí podmínky pojištění.'; }

      return null;

    },

  },

  /* Smluvní podmínky */ {

    title: 'Smluvní podmínky',

    help: 'Posuňte text až na konec, zaškrtněte všechna tři potvrzení a opište slovo SOUHLASÍM velkými písmeny.',

    render: d => `

      <p>Přečtěte si smluvní podmínky a poté potvrďte souhlas. Potvrzení se zpřístupní po posunutí textu až na konec.</p>

      <div class="scrollbox" tabindex="0" aria-label="Smluvní podmínky">${TERMS.map(t => `<p>${esc(t)}</p>`).join('')}</div>

      ${chk('t1', 'Souhlasím se smluvními podmínkami', d.t1, d.termsScrolled ? '' : 'disabled')}

      ${chk('t2', 'Potvrzuji, že jsem se s podmínkami seznámil(a)', d.t2, d.termsScrolled ? '' : 'disabled')}

      ${chk('t3', 'Souhlasím s elektronickým uzavřením smlouvy a se zpracováním osobních údajů podle čl. VI', d.t3, d.termsScrolled ? '' : 'disabled')}

      <div class="row"><label for="tw">Pro potvrzení opište slovo <b>SOUHLASÍM</b> velkými písmeny:</label>

        <input type="text" id="tw" data-k="termsWord" autocomplete="off" value="${esc(d.termsWord)}" ${d.termsScrolled ? '' : 'disabled'}></div>`,

    bind(r, d) {

      const box = $('.scrollbox', r);

      box.addEventListener('scroll', () => {

        if (!d.termsScrolled && box.scrollTop + box.clientHeight >= box.scrollHeight - 3) {

          d.termsScrolled = true;

          $$('input[data-k^="t"]', r).forEach(i => { i.disabled = false; });

        }

      });

    },

    validate: d => {

      if (!d.termsScrolled) return 'Smluvní podmínky nebyly dočteny až do konce.';

      if (!(d.t1 && d.t2 && d.t3)) return 'Zaškrtněte všechna tři potvrzení.';

      if (d.termsWord.trim() !== 'SOUHLASÍM') return 'Slovo SOUHLASÍM nebylo opsáno správně (velkými písmeny a s diakritikou).';

      return null;

    },

  },

  /* Kontrola údajů */ {

    title: 'Kontrola údajů',

    help: 'Zkontrolujte údaje, zadejte své členské číslo v opačném pořadí číslic a zvolte potvrzení správnosti údajů.',

    render: d => {

      const dates = computeDates(d);

      const rows = [

        ['Člen č.', session.member],

        ['Zařízení', 'Oscilotoskop'],

        ['Účel', PURPOSE[d.purposeCat]],

        ['Doba výpůjčky', `${dates.days} dní`],

        ['Od – do', `${fmt(dates.from)} – ${fmt(dates.until)}`],

        ['Převzetí', PICKUP[d.pickup]],

        ['Telefon', d.phone.trim()],

        ['Pojištění', INSURANCE[d.insurance]],

      ];

      return `<p>Zkontrolujte zadané údaje.</p>

        <div class="lvwrap" style="max-height:130px"><table class="lv"><thead><tr><th>Položka</th><th>Hodnota</th></tr></thead><tbody>

          ${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></div>

        <div class="row"><label for="cm">Kontrolní zadání – členské číslo v opačném pořadí číslic:</label>

          <input type="text" id="cm" class="num" maxlength="4" inputmode="numeric" autocomplete="off" data-k="confirmMember" value="${esc(d.confirmMember)}"></div>

        <div class="row"><label for="ct">Potvrzení správnosti údajů:</label>

          <select id="ct" data-k="certainty">

            <option value="">— vyberte —</option>

            <option value="spravne" ${d.certainty === 'spravne' ? 'selected' : ''}>Údaje jsou správné</option>

            <option value="uplne" ${d.certainty === 'uplne' ? 'selected' : ''}>Údaje jsou správné a úplné</option>

            <option value="zavazne" ${d.certainty === 'zavazne' ? 'selected' : ''}>Údaje jsou správné, úplné a závazné</option>

            <option value="nespravne" ${d.certainty === 'nespravne' ? 'selected' : ''}>Údaje nejsou správné</option>

          </select></div>

        <div class="hint">K odeslání je vyžadováno potvrzení „Údaje jsou správné, úplné a závazné“.</div>`;

    },

    validate: d => {

      const rev = session.member.split('').reverse().join('');

      if (d.confirmMember.trim() !== rev) return 'Kontrolní zadání nesouhlasí. Zadejte číslice svého členského čísla v opačném pořadí.';

      if (d.certainty !== 'zavazne') return 'Pro pokračování zvolte potvrzení „Údaje jsou správné, úplné a závazné“.';

      return null;

    },

  },

  /* Odeslání žádosti */ {

    title: 'Odeslání žádosti',

    next: 'Dokončit',

    help: 'Potvrďte obě políčka a klikněte na tlačítko Dokončit. Žádost bude odeslána e-mailem.',

    render: d => `

      <p>Kliknutím na tlačítko <b>Dokončit</b> uložíte žádost do sdílené evidence. Administrátor dostane e-mailové upozornění na adresu <b>${esc(CONFIG.EMAIL)}</b>. Výpůjčka bude aktivní až po schválení žádosti.</p>

      <fieldset><legend>Závěrečné potvrzení</legend>

        ${chk('f1', 'Potvrzuji správnost všech zadaných údajů', d.f1)}

        ${chk('f2', 'Souhlasím s uložením žádosti do sdílené evidence a e-mailovým upozorněním administrátorovi na adresu ' + CONFIG.EMAIL, d.f2)}

      </fieldset>

      <p class="hint">Odeslání může trvat několik sekund. Během odesílání prosím nezavírejte stránku.</p>`,

    validate: d => (d.f1 && d.f2) ? null : 'Zaškrtněte obě závěrečná potvrzení.',

  },

];

const newWizData = () => ({

  understood: '', open: { f1: true }, treeSel: null, chosen: [],

  purposeCat: '', specs: [], purposeText: '',

  weeks: '0', days: '0', start: '',

  quiz: [],

  rules: '', rulesScrolled: false,

  pickup: '', phone: '', insurance: '', insuranceOk: false, tab: 0,

  t1: false, t2: false, t3: false, termsScrolled: false, termsWord: '',

  confirmMember: '', certainty: '',

  f1: false, f2: false,

});

/* =====================================================================

 *  PRŮVODCE – OVLÁDÁNÍ

 * ===================================================================== */

function bindModel(root, d, cb) {

  root.oninput = e => {

    const el = e.target, k = el.dataset && el.dataset.k;

    if (!k) return;

    if (el.dataset.arr) {

      const a = d[k], i = a.indexOf(el.value);

      if (el.checked && i < 0) a.push(el.value);

      if (!el.checked && i >= 0) a.splice(i, 1);

    } else if (el.type === 'checkbox') d[k] = el.checked;

    else if (el.type === 'radio') { if (el.checked) d[k] = el.value; }

    else d[k] = el.value;

    cb(k);

  };

}

function startWizard() {

  wiz = { step: 0, d: newWizData() };

  renderWizard();

}

function renderWizard() {

  view = 'wizard';

  const s = STEPS[wiz.step];

  content.innerHTML = `

    <div class="wiz">

      <aside class="wiz-side" aria-hidden="true">

        <svg><use href="#i-scope"/></svg>

        <div class="cap">Vypůjčení přístroje</div>

      </aside>

      <div class="wiz-main">

        <h2 class="wiz-title">${esc(s.title)}</h2>

        <div class="wiz-body" id="wiz-body"></div>

        <div class="wiz-btns">

          <button class="btn" id="w-help">Nápověda</button>

          <span class="spacer"></span>

          <button class="btn" id="w-back" ${wiz.step === 0 ? 'disabled' : ''}>&lt; Zpět</button>

          <button class="btn default" id="w-next">${esc(s.next || 'Další >')}</button>

          <button class="btn" id="w-cancel">Zrušit</button>

        </div>

      </div>

    </div>`;

  drawBody();

  $('#w-help').onclick = () => msg(STEPS[wiz.step].help, 'info', 'Nápověda');

  $('#w-back').onclick = () => { wiz.step--; renderWizard(); };

  $('#w-cancel').onclick = cancelWizard;

  $('#w-next').onclick = async () => {

    const st = STEPS[wiz.step];

    const err = st.validate(wiz.d);

    if (err) {

      await msg(err, 'warn', 'Nelze pokračovat');

      if (st.redraw) drawBody();

      return;

    }

    if (wiz.step === STEPS.length - 1) return finishWizard();

    wiz.step++; renderWizard();

    content.scrollTop = 0;

  };

  setStatus(`Člen č. ${session.member} – vypůjčení přístroje`, deviceState());

}

function drawBody() {

  const s = STEPS[wiz.step], body = $('#wiz-body');

  body.onclick = null; body.ondblclick = null;

  body.innerHTML = s.render(wiz.d);

  bindModel(body, wiz.d, k => s.onModel && s.onModel(body, wiz.d, k));

  if (s.bind) s.bind(body, wiz.d, drawBody);

}

async function cancelWizard() {

  const i = await dialog({

    type: 'question', title: 'Zrušení výpůjčky',

    text: 'Opravdu si nepřejete výpůjčku nezrušit?',

    buttons: [{ label: 'Ano' }, { label: 'Ne' }, { label: 'Zrušit' }],

  });

  // „Ne“ = skutečně zrušit (návrat na hlavní stránku); „Ano“ i „Zrušit“ = pokračovat v průvodci.

  if (i === 1) renderMain();

}

/* =====================================================================

 *  ODESLÁNÍ A ZAPSÁNÍ VÝPŮJČKY

 * ===================================================================== */

function computeDates(d) {

  const days = (parseInt(d.weeks, 10) || 0) * 7 + (parseInt(d.days, 10) || 0);

  const offset = { ihned: 0, zitra: 1, tyden: 7 }[d.start] || 0;

  const from = new Date(); from.setDate(from.getDate() + offset);

  const until = new Date(from); until.setDate(until.getDate() + days);

  return { days, from: from.toISOString(), until: until.toISOString() };

}

function buildPayload() {

  const d = wiz.d, dates = computeDates(d);

  const specNames = { napeti: 'měření napětí', frekvence: 'měření frekvence', prubehy: 'pozorování průběhů signálu', seznameni: 'seznámení s přístrojem' };

  return {

    subject: `Souhlas s vypůjčením oscilotoskopu – člen č. ${session.member}`,

    dates,

    purpose: PURPOSE[d.purposeCat],

    fields: {

      'Členské číslo': session.member,

      'Zařízení': 'Oscilotoskop',

      'Začátek výpůjčky': fmt(dates.from),

      'Konec výpůjčky': fmt(dates.until),

      'Doba (dní)': String(dates.days),

      'Účel': PURPOSE[d.purposeCat],

      'Upřesnění': d.specs.map(s => specNames[s]).join(', '),

      'Zdůvodnění': d.purposeText.trim(),

      'Převzetí': PICKUP[d.pickup],

      'Telefon': d.phone.trim(),

      'Pojištění': INSURANCE[d.insurance],

      'Souhlas se smluvními podmínkami': 'ANO (' + d.termsWord.trim() + ')',

      'Odesláno': new Date().toLocaleString('cs-CZ'),

    },

  };

}

async function finishWizard() {
  const p = buildPayload();
  let notificationSent = null;
  for (;;) {
    const ov = progressOverlay();
    let result = null, err = null;
    await Promise.all([
      api('submitLoanRequest', session.member, p).then(value => { result = value; }).catch(error => { err = error; }),
      ov.run(CONFIG.SEND_MIN_MS)
    ]);
    ov.close();
    if (result && result.ok) { notificationSent = result.notificationSent === true; break; }

    // Při ztracené odpovědi ověříme, zda se žádost na serveru přesto uložila.
    try {
      const latest = normalizeDb(await api('getPublicState', session.member));
      if (latest.pendingForMe) { db = latest; break; }
    } catch (ignored) { /* zobrazíme původní chybu níže */ }

    const i = await dialog({
      type: 'error', title: 'Uložení se nezdařilo',
      text: `Žádost se nepodařilo uložit do sdílené evidence.\n(${(err && err.message) || 'neznámá chyba'})\n\nZkuste to znovu nebo se vraťte do formuláře.`,
      buttons: [{ label: 'Zkusit znovu' }, { label: 'Zpět' }],
      width: 440
    });
    if (i === 0) continue;
    return;
  }
  try { db = normalizeDb(await api('getPublicState', session.member)); } catch (ignored) { db.pending = true; db.pendingForMe = true; }
  renderDone(p, notificationSent);
}

function renderDone(p, notificationSent) {
  view = 'done'; wiz = null;
  content.innerHTML = `
    <div class="ok-box">
      <div class="mi mi-info"></div>
      <div>
        <h2>Žádost byla odeslána</h2>
        <p>Žádost byla uložena do sdílené evidence. ${notificationSent === true ? 'Administrátor byl upozorněn e-mailem.' : notificationSent === false ? 'E-mailové upozornění se nepodařilo odeslat; administrátor žádost uvidí po přihlášení.' : 'Stav e-mailového upozornění se nepodařilo ověřit; žádost je přesto uložená v evidenci.'}</p>
        <p><b>Výpůjčka zatím není schválena.</b> Přístroj bude veden jako vypůjčený až po schválení administrátorem.</p>
      </div>
    </div>
    <fieldset><legend>Požadovaný termín</legend>
      <table class="kv">
        <tr><td>Žadatel:</td><td>člen č. ${esc(session.member)}</td></tr>
        <tr><td>Od:</td><td>${fmt(p.dates.from)}</td></tr>
        <tr><td>Do:</td><td>${fmt(p.dates.until)}</td></tr>
      </table>
    </fieldset>
    <div class="btnrow"><button class="btn default" id="d-back">Zpět na hlavní stránku</button></div>`;
  $('#d-back').onclick = async () => {
    try { db = normalizeDb(await api('getPublicState', session.member)); } catch (ignored) {}
    renderMain();
  };
  $('#d-back').focus();
  setStatus('Žádost čeká na schválení', deviceState());
}

/* =====================================================================

 *  OKNO

 * ===================================================================== */

$('#btn-close').onclick = async () => {

  if (!session) {

    await msg('Pro ukončení práce zavřete kartu prohlížeče.');

    return;

  }

  const i = await dialog({

    type: 'question', title: 'Odhlášení',

    text: 'Opravdu se chcete odhlásit?\nRozpracovaná výpůjčka nebude uložena.',

    buttons: [{ label: 'Odhlásit' }, { label: 'Zůstat přihlášen' }],

  });

  if (i === 0) renderLogin();

};

// Sdílený stav se načítá ze serveru, takže změny vidí i ostatní návštěvníci.
async function pollSharedState() {
  if (!session || view === 'wizard' || view === 'done') return;
  try {
    if (view === 'admin') {
      const active = document.activeElement;
      if (active && content.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
      const nextAdmin = await api('getAdminData', adminToken);
      const signature = value => JSON.stringify({ state: value.state, requests: (value.requests || []).map(r => [r.id, r.status, r.decidedAt, r.approvedFrom, r.approvedUntil]) });
      if (!adminDataCache || signature(nextAdmin) !== signature(adminDataCache)) renderAdmin(nextAdmin);
      return;
    }
    const next = normalizeDb(await api('getPublicState', session.member));
    const changed = JSON.stringify(next) !== JSON.stringify(db);
    db = next;
    if (changed && view === 'main') renderMain();
    else setStatus(`Přihlášen člen č. ${session.member}`, deviceState());
  } catch (ignored) { /* dočasné přerušení sítě; další cyklus to zkusí znovu */ }
}

window.setInterval(pollSharedState, 15000);

content.innerHTML = '<p>Načítání sdíleného stavu…</p>';
api('getPublicState').then(state => { db = normalizeDb(state); renderLogin(); }).catch(error => {
  content.innerHTML = `<p>Nepodařilo se načíst sdílenou evidenci: ${esc(error.message || error)}. Zkuste stránku obnovit.</p><button class="btn default" id="retry-load">Opakovat</button>`;
  $('#retry-load').onclick = () => location.reload();
});

})();
