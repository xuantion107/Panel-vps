'use strict';
// ╔══════════════════════════════════════════════════════════════════╗
// ║         CELESTIA PAYMENT MODULE — v5 STANDALONE                 ║
// ║         Atlantic H2H + QRIS Otomatis                            ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  CARA PAKAI — gabungkan ke script apapun:                       ║
// ║                                                                  ║
// ║    const pay = require('./payment');                             ║
// ║                                                                  ║
// ║    // 1. Buat invoice                                            ║
// ║    const inv = await pay.createInvoice(db, userId, 'p15', PLANS)║
// ║    // 2. Kirim QR                                                ║
// ║    const img = await pay.generateQrisImage(inv.qrString, './tmp')║
// ║    // 3. Poll status                                             ║
// ║    const res = await pay.checkStatus(inv.reffId)                 ║
// ║    if (pay.isPaid(res))    { /* aktifkan user */ }               ║
// ║    if (pay.isExpired(res)) { /* expired */      }                ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  ENV VARIABLES:                                                  ║
// ║    ATLANTIC_API_KEY  = API key dari atlantich2h.com              ║
// ║    FIXIE_URL         = (Railway) dari addon Fixie                ║
// ║    ATLANTIC_METODE   = qris  (default)                           ║
// ║    ATLANTIC_TYPE     = ewallet (default)                         ║
// ║    DEBUG_PAY         = 1  (log detail)                           ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  SETUP FIXIE (Railway — wajib):                                  ║
// ║    1. Railway → project → + New → Fixie                         ║
// ║    2. Fixie dashboard → catat Outbound IPs                       ║
// ║    3. atlantich2h.com → API → IP Whitelist → tambah IP → OTP    ║
// ╚══════════════════════════════════════════════════════════════════╝

const https  = require('https');
const zlib   = require('zlib');
const net    = require('net');
const tls    = require('tls');
const urlMod = require('url');
const fs     = require('fs');
const path   = require('path');

const API_KEY    = process.env.ATLANTIC_API_KEY || 'dEvFLhVXa8YMQRimdC1XwhmP3yBA9vnBdlzkWT7U0n2TGApCObxDvDQD5bfRJOQEe8L6gePIjtjS1AuqltBasnZvcZ7gxr60tGyO';
const METODE     = process.env.ATLANTIC_METODE  || 'qris';
const TYPE       = process.env.ATLANTIC_TYPE    || 'ewallet';
const BASE       = 'atlantich2h.com';
const QR_TTL     = 3 * 60_000;
const DEBUG      = !!process.env.DEBUG_PAY;
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

function parseFixieUrl(raw) {
  if (!raw) return null;
  try {
    const u = new urlMod.URL(raw);
    return { host: u.hostname, port: parseInt(u.port||'80',10), user: decodeURIComponent(u.username||''), pass: decodeURIComponent(u.password||'') };
  } catch(_) {
    const m = raw.match(/^https?:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)/);
    if (m) return { user:m[1], pass:m[2], host:m[3], port:parseInt(m[4],10) };
    return null;
  }
}

const FIXIE     = parseFixieUrl(process.env.FIXIE_URL);
const USE_PROXY = !process.env.PROXY_DISABLED && !!FIXIE;

if (DEBUG) {
  if (USE_PROXY)       console.log(`[pay] Fixie: ${FIXIE.host}:${FIXIE.port}`);
  else if (ON_RAILWAY) console.warn('[pay] WARNING: Railway tanpa FIXIE_URL!');
  else                 console.log('[pay] Direct connection');
}

// ── Utilities ───────────────────────────────────────────────────────

function genOrderId() {
  const d = new Date();
  return 'VPS' + [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'),
    String(d.getHours()).padStart(2,'0'),String(d.getMinutes()).padStart(2,'0'),String(d.getSeconds()).padStart(2,'0')
  ].join('') + Math.random().toString(36).slice(2,6).toUpperCase();
}

function parseJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(_) {}
  const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch(_) {} }
  const a = raw.match(/\[[\s\S]*\]/); if (a) { try { return JSON.parse(a[0]); } catch(_) {} }
  return null;
}

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(_) {} }

// ── Fixie Tunnel ─────────────────────────────────────────────────────

function createFixieTunnel(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!FIXIE) return reject(new Error('Fixie tidak dikonfigurasi'));
    const target  = `${BASE}:443`;
    const authB64 = Buffer.from(`${FIXIE.user}:${FIXIE.pass}`).toString('base64');
    const socket  = net.createConnection({ host: FIXIE.host, port: FIXIE.port });
    let responded = false;
    const timer   = setTimeout(() => { if (!responded) { socket.destroy(); reject(new Error('Fixie timeout')); } }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${authB64}\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', chunk => {
      if (responded) return;
      buf += chunk.toString('binary');
      if (!buf.includes('\r\n\r\n')) return;
      responded = true; clearTimeout(timer);
      const sl = buf.split('\r\n')[0];
      if (sl.includes('200')) { socket.removeAllListeners('data'); resolve(socket); }
      else { socket.destroy(); reject(new Error(`Fixie CONNECT gagal ${sl.match(/\d{3}/)?.[0]||'?'} — whitelist IP Fixie di atlantich2h.com`)); }
    });
    socket.on('error', e => { clearTimeout(timer); if (!responded) reject(new Error('Fixie: '+e.message)); });
    socket.on('close', () => { clearTimeout(timer); if (!responded) reject(new Error('Fixie ditutup'));  });
  });
}

function postViaFixie(endpoint, body, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try { socket = await createFixieTunnel(Math.floor(timeoutMs*0.4)); } catch(e) { return reject(e); }
    const tlsSock = tls.connect({ socket, servername: BASE, rejectUnauthorized: true });
    const timer   = setTimeout(() => { tlsSock.destroy(); reject(new Error('Timeout Fixie')); }, timeoutMs);
    tlsSock.on('error', e => { clearTimeout(timer); reject(new Error('TLS: '+e.message)); });
    tlsSock.on('secureConnect', () => {
      tlsSock.write(
        `POST ${endpoint} HTTP/1.1\r\nHost: ${BASE}\r\n` +
        `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Accept-Encoding: gzip, deflate\r\nAccept: application/json, */*\r\n` +
        `User-Agent: Mozilla/5.0\r\nOrigin: https://${BASE}\r\nReferer: https://${BASE}/deposit\r\n` +
        `Connection: close\r\n\r\n${body}`
      );
    });
    let hDone=false, sc=200, enc='', hBuf='', bChunks=[];
    tlsSock.on('data', chunk => {
      if (!hDone) {
        hBuf += chunk.toString('binary');
        const sep = hBuf.indexOf('\r\n\r\n');
        if (sep===-1) return;
        hDone=true;
        const hdr = hBuf.slice(0,sep);
        sc  = parseInt(hdr.match(/HTTP\/\S+\s+(\d+)/)?.[1]||'200',10);
        enc = (hdr.match(/content-encoding:\s*([^\r\n]+)/i)?.[1]||'').toLowerCase().trim();
        const rest = hBuf.slice(sep+4); if (rest) bChunks.push(Buffer.from(rest,'binary')); return;
      }
      bChunks.push(chunk);
    });
    tlsSock.on('end', async () => {
      clearTimeout(timer);
      try {
        let buf = Buffer.concat(bChunks);
        if (enc.includes('gzip'))    buf = await new Promise((r,x)=>zlib.gunzip(buf,(e,d)=>e?x(e):r(d)));
        else if (enc.includes('deflate')) buf = await new Promise((r,x)=>zlib.inflate(buf,(e,d)=>e?x(e):r(d)));
        else if (enc.includes('br')) { try { buf=await new Promise((r,x)=>zlib.brotliDecompress(buf,(e,d)=>e?x(e):r(d))); } catch(_){} }
        resolve({ statusCode:sc, raw:buf.toString('utf8').trim() });
      } catch(e) { reject(e); }
    });
    tlsSock.on('error', e => { clearTimeout(timer); reject(new Error('Fixie resp: '+e.message)); });
  });
}

// ── Direct Connection ────────────────────────────────────────────────

function postDirect(endpoint, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    const timer = setTimeout(() => { try{req.destroy();}catch(_){} reject(new Error('Timeout direct')); }, timeoutMs);
    // Header lengkap mirip browser untuk bypass Cloudflare
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': `https://${BASE}`,
      'Referer': `https://${BASE}/deposit`,
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
    };
    req = https.request({
      hostname:BASE, port:443, path:endpoint, method:'POST', headers,
    }, async res => {
      try {
        const enc=(res.headers['content-encoding']||'').toLowerCase();
        let stream=res;
        if (enc.includes('gzip'))         stream=res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream=res.pipe(zlib.createInflate());
        else if (enc.includes('br'))      { try{stream=res.pipe(zlib.createBrotliDecompress());}catch(_){} }
        const chunks=[]; stream.on('data',c=>chunks.push(c));
        stream.on('end',()=>{ clearTimeout(timer); resolve({statusCode:res.statusCode, raw:Buffer.concat(chunks).toString('utf8').trim()}); });
        stream.on('error',e=>{ clearTimeout(timer); reject(e); });
      } catch(e) { clearTimeout(timer); reject(e); }
    });
    req.on('error',e=>{ clearTimeout(timer); reject(new Error('Direct: '+e.message)); });
    req.write(body); req.end();
  });
}

// ── Validate & PostForm ──────────────────────────────────────────────

function validateResponse({statusCode, raw}) {
  const isCf = statusCode===403 || raw.includes('Just a moment') || raw.includes('cf-browser-verification') ||
    raw.includes('Enable JavaScript') || (raw.startsWith('<!') && raw.toLowerCase().includes('cloudflare'));
  if (isCf) {
    if (USE_PROXY) throw new Error('IP Fixie diblokir Cloudflare!\nBuka Fixie dashboard → salin IPs\nLogin atlantich2h.com → API → IP Whitelist → tambah → OTP → Simpan');
    // Coba lagi dengan pendekatan alternatif - jangan langsung throw
    throw new Error('CF_BLOCKED');
  }
  if (statusCode===429) throw new Error('Rate limit Atlantic. Tunggu 1 menit.');
  if (statusCode>=500)  throw new Error(`Server Atlantic error (HTTP ${statusCode}).`);
  if (!raw)             throw new Error('Response kosong dari Atlantic');
  const json = parseJSON(raw);
  if (json) return json;
  throw new Error(`Response tidak valid (HTTP ${statusCode}): ${raw.slice(0,150)}`);
}

async function postForm(endpoint, params, timeoutMs=25000) {
  const body = new URLSearchParams(params).toString();
  if (DEBUG) console.log(`[pay] POST ${endpoint} proxy:${USE_PROXY}`);
  if (USE_PROXY) {
    try { return validateResponse(await postViaFixie(endpoint, body, timeoutMs)); }
    catch(e) {
      if (e.message.includes('Cloudflare')||e.message.includes('whitelist')||e.message.includes('CONNECT')) throw e;
      console.log('[pay] Fixie gagal, coba direct:', e.message);
    }
  }
  return validateResponse(await postDirect(endpoint, body, timeoutMs));
}

async function postFormRetry(endpoint, params, timeoutMs=25000, maxRetry=3) {
  let lastErr;
  for (let i=0; i<maxRetry; i++) {
    try { return await postForm(endpoint, params, timeoutMs); }
    catch(e) {
      lastErr=e;
      if (e.message.includes('whitelist') && USE_PROXY) throw e;
      if (e.message === 'CF_BLOCKED') {
        // CF blocked - tunggu lebih lama lalu retry
        if (i < maxRetry-1) {
          console.log(`[pay] CF blocked, retry ${i+1} in 5s...`);
          await new Promise(r=>setTimeout(r,5000));
          continue;
        }
        throw new Error('IP Railway diblokir Cloudflare Atlantic.\nSolusi: tambah FIXIE_URL di Railway (Railway → + New → Fixie)\nlalu whitelist IP Fixie di atlantich2h.com → API → IP Whitelist');
      }
      if (i<maxRetry-1) { console.log(`[pay] retry ${i+1}:`,e.message); await new Promise(r=>setTimeout(r,2000)); }
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════════════════════
//  FUNGSI UTAMA
// ═══════════════════════════════════════════════════════════════════

/**
 * createDeposit — Buat QRIS deposit baru
 * @param {string} reffId  - ID order unik (pakai genOrderId())
 * @param {number} nominal - Nominal dalam Rupiah
 * @returns {Object}       - Data dari Atlantic (qr_string, qr_image, expired_at)
 */
async function createDeposit(reffId, nominal) {
  if (!API_KEY) throw new Error('ATLANTIC_API_KEY belum diset di Environment Variables!');
  const json = await postFormRetry('/deposit/create', { api_key:API_KEY, reff_id:reffId, nominal:String(nominal), type:TYPE, metode:METODE });
  if (DEBUG) console.log('[pay] createDeposit:', JSON.stringify(json).slice(0,400));
  const d = json.data || json;
  const ok = json.status===true||json.status===1||json.status==='true'||json.success===true||json.code===200||json.code==='200'||d.qr_string||d.qr_image;
  if (!ok) throw new Error('Atlantic: ' + String(json.message||json.msg||d?.message||d?.msg||'Gagal buat QRIS'));
  if (!d.qr_string  && json.qr_string)  d.qr_string  = json.qr_string;
  if (!d.qr_image   && json.qr_image)   d.qr_image   = json.qr_image;
  if (!d.expired_at && json.expired_at) d.expired_at = json.expired_at;
  return d;
}

/**
 * checkStatus — Cek status pembayaran
 * @param {string} reffId - ID order
 * @returns {Object|null}
 */
async function checkStatus(reffId) {
  if (!API_KEY) return null;
  try {
    const json = await postFormRetry('/deposit/status', { api_key:API_KEY, reff_id:reffId }, 15000);
    console.log('[pay] checkStatus raw:', JSON.stringify(json).slice(0,300));
    return json;
  } catch(e) { console.log('[pay] checkStatus error:', e.message); return null; }
}

/**
 * isPaid — Apakah sudah dibayar?
 * Mendukung semua format response Atlantic
 */
function isPaid(obj) {
  if (!obj) return false;
  const PAID = ['success','paid','settlement','completed','berhasil','active','sukses','diterima'];
  const candidates = [];
  function collect(o) {
    if (!o||typeof o!=='object') return;
    for (const k of ['status','payment_status','trx_status','transaction_status','Status','keterangan','message','msg','ket'])
      if (o[k]!=null) candidates.push(String(o[k]).toLowerCase().trim());
    if (o.data)        collect(o.data);
    if (o.transaction) collect(o.transaction);
    if (o.result)      collect(o.result);
  }
  collect(obj);
  for (const val of candidates) {
    if (PAID.some(w => val.includes(w))) { if(DEBUG) console.log('[pay] isPaid MATCH:',val); return true; }
  }
  const raw = JSON.stringify(obj).toLowerCase();
  if (raw.includes('"settlement"')||raw.includes('"success"')||raw.includes('"paid"')) { if(DEBUG) console.log('[pay] isPaid raw MATCH'); return true; }
  return false;
}

/**
 * isExpired — Apakah sudah expired/cancelled?
 */
function isExpired(obj) {
  if (!obj) return false;
  const EXP = ['expired','expire','cancelled','canceled','failed','gagal'];
  function collect(o) {
    if (!o||typeof o!=='object') return false;
    for (const k of ['status','payment_status','trx_status','Status']) {
      const v = String(o[k]??''). toLowerCase().trim();
      if (EXP.some(w=>v.includes(w))) return true;
    }
    return !!(o.data && collect(o.data));
  }
  return collect(obj);
}

/**
 * generateQrisImage — Generate gambar PNG dari qr_string
 * @param {string} qrString - qr_string dari Atlantic
 * @param {string} tmpDir   - Folder untuk simpan file temp
 * @returns {string}        - Path file PNG
 */
async function generateQrisImage(qrString, tmpDir) {
  if (!qrString) throw new Error('qr_string kosong');
  let QRCode;
  try { QRCode = require('qrcode'); }
  catch(_) { throw new Error('Package qrcode belum install: npm install qrcode'); }
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `_qris_${Date.now()}.png`);
  await QRCode.toFile(tmp, qrString, { type:'png', width:600, margin:3, color:{dark:'#000000',light:'#FFFFFF'}, errorCorrectionLevel:'M' });
  return tmp;
}

/**
 * createInvoice — Buat & simpan invoice ke db.invoices
 *
 * @param {Object} db     - Object database (misal DB dari bot.js)
 * @param {string} userId - Telegram chat ID user
 * @param {string} planId - ID paket
 * @param {Object} plans  - Object PLANS { p15:{harga,hari,nama,role,maxSrv}, ... }
 * @returns {Object}      - Invoice yang dibuat
 *
 * Contoh PLANS:
 * const PLANS = {
 *   p15:   { id:'p15',   nama:'Premium 15 Hari', harga:2500,  hari:15,  role:'premium', maxSrv:5  },
 *   p30:   { id:'p30',   nama:'Premium 30 Hari', harga:10000, hari:30,  role:'premium', maxSrv:10 },
 *   owner: { id:'owner', nama:'Owner 1 Tahun',   harga:50000, hari:365, role:'owner',   maxSrv:50 },
 * };
 */
async function createInvoice(db, userId, planId, plans) {
  const plan = plans[planId];
  if (!plan) throw new Error('Plan tidak valid: ' + planId);
  const reffId = genOrderId();
  const data   = await createDeposit(reffId, plan.harga);
  if (!data.qr_string && !data.qr_image) throw new Error('Atlantic tidak mengembalikan QR');
  if (!db.invoices) db.invoices = {};
  let expireTs = Date.now() + QR_TTL;
  if (data.expired_at) { try { const ts=new Date(data.expired_at).getTime(); if(ts>Date.now()) expireTs=ts; } catch(_){} }
  const inv = {
    reffId, userId:String(userId), planId,
    harga:plan.harga, nama:plan.nama, status:'pending',
    qrString:data.qr_string||'', qrImage:data.qr_image||'',
    atlanticId:data.id||data.trx_id||'',
    expiredAt:data.expired_at||null, expireTs, createdAt:Date.now(),
  };
  db.invoices[reffId] = inv;
  return inv;
}

// ═══════════════════════════════════════════════════════════════════
//  CONTOH INTEGRASI (copy-paste ke bot kamu)
// ═══════════════════════════════════════════════════════════════════
//
//  const pay = require('./payment');
//
//  const PLANS = {
//    p15:   { id:'p15',   nama:'Premium 15 Hari', harga:2500,  hari:15,  role:'premium', maxSrv:5  },
//    p30:   { id:'p30',   nama:'Premium 30 Hari', harga:10000, hari:30,  role:'premium', maxSrv:10 },
//    owner: { id:'owner', nama:'Owner 1 Tahun',   harga:50000, hari:365, role:'owner',   maxSrv:50 },
//  };
//
//  // ── Saat user klik beli ──────────────────────────────────────
//  bot.on('callback_query', async q => {
//    const chatId = q.message.chat.id;
//    const data   = q.data;
//
//    if (data.startsWith('buy:')) {
//      const planId = data.slice(4);
//      try {
//        // 1. Buat invoice
//        const inv = await pay.createInvoice(DB, chatId, planId, PLANS);
//
//        // 2. Generate QR image
//        const qrFile = await pay.generateQrisImage(inv.qrString, './tmp');
//
//        // 3. Kirim ke user
//        await bot.sendPhoto(chatId, qrFile, {
//          caption:
//            `💳 *QRIS Pembayaran*\n\n` +
//            `Paket: ${inv.nama}\n` +
//            `Harga: Rp ${inv.harga.toLocaleString('id-ID')}\n\n` +
//            `⏳ Berlaku 3 menit\n` +
//            `_Scan QR di atas dengan m-banking / e-wallet_`,
//          parse_mode: 'Markdown',
//          reply_markup: { inline_keyboard: [[
//            { text: '🔄 Cek Status', callback_data: `cekbayar:${inv.reffId}` }
//          ]]}
//        });
//        pay.safeUnlink(qrFile);
//
//        // 4. Auto-poll status bayar setiap 5 detik
//        const pollTimer = setInterval(async () => {
//          const res = await pay.checkStatus(inv.reffId);
//
//          if (pay.isPaid(res)) {
//            clearInterval(pollTimer);
//            inv.status = 'paid';
//            // Aktifkan user
//            DB.users[chatId].role   = PLANS[planId].role;
//            DB.users[chatId].expiry = Date.now() + PLANS[planId].hari * 86400_000;
//            DB.users[chatId].maxSrv = PLANS[planId].maxSrv;
//            saveDB(); // simpan ke file
//            await bot.sendMessage(chatId,
//              `✅ *Pembayaran Diterima!*\n\n` +
//              `Paket *${inv.nama}* aktif sekarang!\n` +
//              `Berlaku hingga: ${new Date(DB.users[chatId].expiry).toLocaleDateString('id-ID')}`,
//              { parse_mode: 'Markdown' }
//            );
//          }
//
//          if (pay.isExpired(res)) {
//            clearInterval(pollTimer);
//            inv.status = 'expired';
//            await bot.sendMessage(chatId, '❌ QRIS expired. Silahkan beli lagi.');
//          }
//        }, 5000);
//
//        // Stop poll setelah 5 menit (batas maksimal)
//        setTimeout(() => clearInterval(pollTimer), 5 * 60_000);
//
//      } catch(e) {
//        await bot.sendMessage(chatId, `❌ Gagal buat QRIS:\n${e.message}`);
//      }
//    }
//
//    // ── Manual cek status ──────────────────────────────────────
//    if (data.startsWith('cekbayar:')) {
//      const reffId = data.slice(9);
//      const res    = await pay.checkStatus(reffId);
//      if (pay.isPaid(res)) {
//        // ... aktifkan user
//      } else {
//        await bot.answerCallbackQuery(q.id, { text: 'Belum dibayar', show_alert: false });
//      }
//    }
//  });
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  QR_TTL,
  genOrderId,
  safeUnlink,
  cleanTmp: safeUnlink,
  createDeposit,
  checkStatus,
  isPaid,
  isExpired,
  createInvoice,
  generateQrisImage,
};
