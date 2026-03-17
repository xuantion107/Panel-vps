'use strict';

const { Telegraf, Markup, session } = require('telegraf');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode   = require('qrcode');
const pino     = require('pino');
const fs       = require('fs');
const path     = require('path');

// ══════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════
const BOT_TOKEN      = process.env.BOT_TOKEN || '8219268200:AAGYt7K3sQj-ZUZWYeU6dh26R0vRR7M_2OE';
const OWNER_USERNAME = 'XIXI8778';
const ADMIN_IDS      = [8496726839]; // ID admin yang boleh akses panel admin
const DATA_FILE      = './data.json';
const SESSION_DIR    = './sessions';

// Cek apakah user adalah admin
function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

// ══════════════════════════════════════════════════════════════════
//  DATA MANAGER
// ══════════════════════════════════════════════════════════════════
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = { users: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { users: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getUser(userId) {
  const data = loadData();
  if (!data.users[userId]) {
    data.users[userId] = {
      id: userId, premium: false, premiumExpiry: null,
      senderConnected: false, createdAt: new Date().toISOString(),
    };
    saveData(data);
  }
  return data.users[userId];
}

function saveUser(userId, patch) {
  const data = loadData();
  data.users[userId] = { ...data.users[userId], ...patch };
  saveData(data);
}

function isPremiumActive(userId) {
  const u = getUser(userId);
  return u.premium && u.premiumExpiry && new Date(u.premiumExpiry) > new Date();
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sessionPath(userId) {
  return path.join(SESSION_DIR, `session_${userId}`);
}

function deleteSession(userId) {
  const p = sessionPath(userId);
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// ══════════════════════════════════════════════════════════════════
//  WA CONNECTION POOL
// ══════════════════════════════════════════════════════════════════
const waPool = {};

// Cache versi Baileys agar tidak fetch ulang setiap koneksi
let cachedVersion = null;
async function getVersion() {
  if (cachedVersion) return cachedVersion;
  const { version } = await fetchLatestBaileysVersion();
  cachedVersion = version;
  return version;
}

function isConnected(userId) {
  return waPool[userId]?.status === 'connected';
}

function closeSocket(userId) {
  try {
    const entry = waPool[userId];
    if (entry?.sock) {
      entry.sock.ev.removeAllListeners();
      try { entry.sock.ws?.close(); } catch {}
      try { entry.sock.end(undefined); } catch {}
    }
  } catch {}
  delete waPool[userId];
}

async function autoReconnect(userId) {
  await sleep(6000);
  if (isConnected(userId)) return;
  console.log(`[AutoReconnect] userId=${userId}`);
  connectWA({ userId, mode: 'reconnect' }).catch(e =>
    console.error('[AutoReconnect] error:', e?.message)
  );
}

// ══════════════════════════════════════════════════════════════════
//  CORE CONNECT
//  mode: 'qr' | 'pairing' | 'reconnect'
//
//  FLOW YANG BENAR (berdasarkan source Baileys + testing):
//
//  process.nextTick → emit { connection:'connecting' }
//    ← JANGAN panggil requestPairingCode di sini!
//    ← WebSocket belum open, sendNode() akan throw "Connection Closed"
//
//  WebSocket.open → validateConnection() → noise handshake selesai
//  Server WA kirim 'CB:iq,type:set,pair-device'
//  → Baileys emit { qr: "..." }
//    ← INILAH saat yang tepat! WebSocket open + handshake done + server siap
//    ← Mode QR: render gambar QR
//    ← Mode Pairing: panggil requestPairingCode() → server kirim notif ke HP
//
//  User masukkan kode di HP
//  → Server kirim 'CB:iq,,pair-success'
//  → Server kirim 'CB:success'
//  → emit { connection: 'open' }
// ══════════════════════════════════════════════════════════════════
async function connectWA({ userId, mode, phoneNumber, onQR, onPairingCode, onConnected, onDisconnected }) {
  closeSocket(userId);

  const sp = sessionPath(userId);
  if (!fs.existsSync(sp)) fs.mkdirSync(sp, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sp);
  const version              = await getVersion();

  const sock = makeWASocket({
    version,
    logger                        : pino({ level: 'silent' }),
    auth                          : state,
    printQRInTerminal             : false,
    browser                       : ['ZangBot', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory               : false,
    markOnlineOnConnect           : false,
    connectTimeoutMs              : 60000,
    defaultQueryTimeoutMs         : 0,
  });

  waPool[userId] = { sock, status: 'connecting' };

  let pairingRequested = false;
  let connectedFired   = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR event: WebSocket open + handshake selesai + server siap ──
    if (qr) {
      if (mode === 'qr') {
        // Mode QR: kirim gambar QR ke user
        try { if (onQR) onQR(qr); } catch {}

      } 
      // Improved pairing: request code when connection starts (more reliable)
      if (connection === 'connecting' && mode === 'pairing' && !pairingRequested) {
        pairingRequested = true;
        const clean = phoneNumber.replace(/[^0-9]/g, '');
        console.log(`[Pairing] Requesting code for +${clean}`);

        try {
          const code = await sock.requestPairingCode(clean);
          console.log(`[Pairing] Pairing Code: ${code}`);
          if (onPairingCode) onPairingCode(String(code));
        } catch (e) {
          console.error('[Pairing] Failed to get code:', e?.message);
          if (onDisconnected) onDisconnected('PAIRING_FAILED');
        }
      }

        if (code) {
          try { if (onPairingCode) onPairingCode(String(code)); } catch {}
        } else {
          try { if (onDisconnected) onDisconnected('PAIRING_FAILED'); } catch {}
        }
      }
    }

    // ── Berhasil terhubung ───────────────────────────────────────
    if (connection === 'open' && !connectedFired) {
      connectedFired = true;
      waPool[userId].status = 'connected';
      saveUser(userId, { senderConnected: true });
      console.log(`[WA] ✅ Connected userId=${userId}`);
      try { if (onConnected) onConnected(); } catch {}
    }

    // ── Terputus ─────────────────────────────────────────────────
    if (connection === 'close') {
      const errCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waPool[userId].status = 'disconnected';
      saveUser(userId, { senderConnected: false });
      console.log(`[WA] ⚠️  Disconnected userId=${userId} errCode=${errCode}`);

      if (errCode === DisconnectReason.loggedOut) {
        deleteSession(userId);
        try { if (onDisconnected) onDisconnected('LOGGED_OUT'); } catch {}
      } else if (connectedFired || mode === 'reconnect') {
        autoReconnect(userId);
      } 
      // Improved pairing: request code when connection starts (more reliable)
      if (connection === 'connecting' && mode === 'pairing' && !pairingRequested) {
        pairingRequested = true;
        const clean = phoneNumber.replace(/[^0-9]/g, '');
        console.log(`[Pairing] Requesting code for +${clean}`);

        try {
          const code = await sock.requestPairingCode(clean);
          console.log(`[Pairing] Pairing Code: ${code}`);
          if (onPairingCode) onPairingCode(String(code));
        } catch (e) {
          console.error('[Pairing] Failed to get code:', e?.message);
          if (onDisconnected) onDisconnected('PAIRING_FAILED');
        }
      }
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

// ══════════════════════════════════════════════════════════════════
//  LOGOUT WHATSAPP
// ══════════════════════════════════════════════════════════════════
async function logoutWhatsApp(userId) {
  const entry = waPool[userId];
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch {}
  }
  closeSocket(userId);
  deleteSession(userId);
  saveUser(userId, { senderConnected: false });
}

// ══════════════════════════════════════════════════════════════════
//  BOT INIT
// ══════════════════════════════════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

function initSession(ctx) {
  if (!ctx.session) ctx.session = {};
}

// ══════════════════════════════════════════════════════════════════
//  MENU BUILDERS
// ══════════════════════════════════════════════════════════════════
function mainMenu(userId) {
  const connected = isConnected(String(userId || ''));
  const rows = [
    [Markup.button.callback('➕ Tambah Sender', 'menu_tambah_sender')],
    [Markup.button.callback('📨 Puss Kontak', 'menu_puss_kontak')],
  ];
  if (connected) rows.push([Markup.button.callback('🔌 Logout Sender', 'menu_logout')]);
  rows.push(
    [Markup.button.callback('👑 Owner', 'menu_owner')],
    [Markup.button.callback('⭐ Upgrade Premium', 'menu_upgrade_premium')],
  );
  if (isAdmin(userId)) {
    rows.push([Markup.button.callback('🛡️ Panel Admin', 'admin_panel')]);
  }
  return Markup.inlineKeyboard(rows);
}

function backBtn(action = 'back_main', label = '🔙 Kembali') {
  return Markup.button.callback(label, action);
}
function cancelBtn(label = '❌ Batal') {
  return Markup.button.callback(label, 'cancel_step');
}
function statusText(userId) {
  const con  = isConnected(String(userId));
  const prem = isPremiumActive(String(userId));
  return `Status Sender : ${con  ? '🟢 Terhubung'   : '🔴 Belum terhubung'}\n` +
         `Status Premium: ${prem ? '⭐ Aktif'        : '🔒 Tidak aktif'}`;
}

// ══════════════════════════════════════════════════════════════════
//  /start
// ══════════════════════════════════════════════════════════════════
bot.start(async (ctx) => {
  initSession(ctx);
  const userId = ctx.from.id;
  getUser(userId);
  const name = ctx.from.first_name || 'Bro';
  await ctx.replyWithMarkdown(
    `🤖 *Selamat datang di ZangBot, ${name}!*\n\n${statusText(userId)}\n\nPilih menu di bawah:`,
    mainMenu(userId)
  );
});

// ══════════════════════════════════════════════════════════════════
//  /menu  /batal
// ══════════════════════════════════════════════════════════════════
bot.command('menu', async (ctx) => {
  initSession(ctx);
  ctx.session.step = null;
  await ctx.replyWithMarkdown(`📋 *Menu Utama ZangBot*\n\n${statusText(ctx.from.id)}`, mainMenu(ctx.from.id));
});

bot.command('batal', async (ctx) => {
  initSession(ctx);
  ctx.session.step = null;
  ctx.session.groupLink = null;
  await ctx.replyWithMarkdown('✅ Dibatalkan.\n\n' + statusText(ctx.from.id), mainMenu(ctx.from.id));
});

// ══════════════════════════════════════════════════════════════════
//  TAMBAH SENDER
// ══════════════════════════════════════════════════════════════════
bot.action('menu_tambah_sender', async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  ctx.session.step = null;
  const userId = String(ctx.from.id);

  if (isConnected(userId)) {
    return ctx.editMessageText(
      '✅ *Sender sudah terhubung!*\n\nLogout dulu jika ingin ganti akun.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[backBtn()]]) }
    );
  }

  await ctx.editMessageText(
    '📱 *Tambah Sender WhatsApp*\n\nPilih metode login:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📷 Scan QR Code', 'login_qr')],
        [Markup.button.callback('🔢 Pairing Code', 'login_pairing')],
        [backBtn()],
      ]),
    }
  );
});

// ══════════════════════════════════════════════════════════════════
//  LOGIN QR
// ══════════════════════════════════════════════════════════════════
bot.action('login_qr', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);

  if (isConnected(userId)) {
    return ctx.editMessageText('✅ Sender sudah terhubung!',
      { ...Markup.inlineKeyboard([[backBtn()]]) });
  }

  await ctx.editMessageText('⏳ *Membuat QR Code...*', { parse_mode: 'Markdown' });

  try {
    let qrSent = false;
    await connectWA({
      userId,
      mode: 'qr',
      onQR: async (qr) => {
        if (qrSent) return;
        qrSent = true;
        try {
          const buf = await qrcode.toBuffer(qr, { type: 'png', scale: 8 });
          await ctx.replyWithPhoto({ source: buf }, {
            caption:
              '📷 *Scan QR Code ini dengan WhatsApp kamu!*\n\n' +
              '1. Buka WhatsApp → Perangkat Tertaut\n' +
              '2. Klik "Tautkan Perangkat"\n' +
              '3. Scan QR di atas\n\n' +
              '⏱ QR berlaku ±60 detik\n' +
              '❌ Ketik /batal untuk membatalkan.',
            parse_mode: 'Markdown',
          });
        } catch (e) { console.error('[QR] send error:', e?.message); }
      },
      onConnected: async () => {
        await ctx.replyWithMarkdown(
          '🎉 *Sender berhasil terhubung!*\n\nWhatsApp kamu sudah aktif sebagai sender.',
          mainMenu(userId)
        );
      },
      onDisconnected: async (reason) => {
        if (reason === 'LOGGED_OUT')
          await ctx.reply('⚠️ Sender di-logout. Silakan login ulang.', mainMenu(userId));
      },
    });
  } catch (e) {
    console.error('[QR] error:', e?.message);
    await ctx.reply('❌ Gagal membuat koneksi. Coba lagi.', mainMenu(userId));
  }
});

// ══════════════════════════════════════════════════════════════════
//  LOGIN PAIRING — minta nomor
// ══════════════════════════════════════════════════════════════════
bot.action('login_pairing', async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  const userId = String(ctx.from.id);

  if (isConnected(userId)) {
    return ctx.editMessageText('✅ Sender sudah terhubung!',
      { ...Markup.inlineKeyboard([[backBtn()]]) });
  }

  ctx.session.step = 'awaiting_phone_pairing';

  await ctx.editMessageText(
    '🔢 *Login dengan Pairing Code*\n\n' +
    '📞 Ketik nomor WhatsApp kamu:\n\n' +
    'Format  : `628xxxxxxxxxx`\n' +
    'Contoh  : `6281234567890`\n\n' +
    '_Tanpa tanda + atau spasi_\n\n' +
    '❌ Tekan Batal atau ketik /batal untuk keluar.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [cancelBtn('❌ Batal')],
        [backBtn('menu_tambah_sender', '🔙 Kembali')],
      ]),
    }
  );
});

// ══════════════════════════════════════════════════════════════════
//  LOGOUT
// ══════════════════════════════════════════════════════════════════
bot.action('menu_logout', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);

  if (!isConnected(userId)) {
    return ctx.editMessageText('⚠️ Sender tidak sedang terhubung.',
      { ...Markup.inlineKeyboard([[backBtn()]]) });
  }

  await ctx.editMessageText(
    '⚠️ *Konfirmasi Logout*\n\n' +
    'Apakah kamu yakin ingin logout?\n' +
    'Bot akan terputus dari WhatsApp kamu.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ya, Logout', 'confirm_logout')],
        [backBtn()],
      ]),
    }
  );
});

bot.action('confirm_logout', async (ctx) => {
  await ctx.answerCbQuery('Sedang logout...');
  const userId = String(ctx.from.id);

  try {
    await ctx.editMessageText('⏳ Sedang logout dari WhatsApp...', { parse_mode: 'Markdown' });
    await logoutWhatsApp(userId);
    await ctx.editMessageText(
      '✅ *Berhasil logout!*\n\nSender sudah terputus dari WhatsApp.\nKamu bisa login ulang kapan saja.',
      { parse_mode: 'Markdown', ...mainMenu(userId) }
    );
  } catch (e) {
    console.error('[Logout] error:', e?.message);
    await ctx.editMessageText('❌ Gagal logout. Coba lagi.', mainMenu(userId));
  }
});

// ══════════════════════════════════════════════════════════════════
//  PUSS KONTAK
// ══════════════════════════════════════════════════════════════════
bot.action('menu_puss_kontak', async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  const userId = String(ctx.from.id);

  if (!isConnected(userId)) {
    return ctx.editMessageText(
      '⚠️ *Kamu belum login Sender!*\n\nTambah Sender dulu.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Tambah Sender', 'menu_tambah_sender')],
          [backBtn()],
        ]),
      }
    );
  }

  ctx.session.step = 'awaiting_group_link';
  await ctx.editMessageText(
    '📨 *Puss Kontak*\n\n' +
    'Kirim link grup WhatsApp:\n' +
    '`https://chat.whatsapp.com/xxxxxxx`\n\n' +
    '❌ Tekan Batal atau ketik /batal untuk keluar.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [cancelBtn('❌ Batal')],
        [backBtn()],
      ]),
    }
  );
});

// ══════════════════════════════════════════════════════════════════
//  OWNER
// ══════════════════════════════════════════════════════════════════
bot.action('menu_owner', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `👑 *Owner / Admin ZangBot*\n\nHubungi admin untuk:\n• Pembelian Premium\n• Laporan bug\n• Pertanyaan fitur\n\nAdmin: @${OWNER_USERNAME}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💬 Chat Admin', `https://t.me/${OWNER_USERNAME}`)],
        [backBtn()],
      ]),
    }
  );
});

// ══════════════════════════════════════════════════════════════════
//  UPGRADE PREMIUM
// ══════════════════════════════════════════════════════════════════
bot.action('menu_upgrade_premium', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const isPrem = isPremiumActive(userId);
  const user   = getUser(userId);

  let premStatus = '';
  if (isPrem) {
    const expiry = new Date(user.premiumExpiry).toLocaleDateString('id-ID');
    premStatus = `\n⭐ *Status kamu: PREMIUM aktif hingga ${expiry}*\n`;
  }

  await ctx.editMessageText(
    `⭐ *Upgrade Premium ZangBot*\n${premStatus}\n` +
    `━━━━━━━━━━━━━━━━━━\n📦 *Paket Tersedia:*\n\n` +
    `🟢 *3 Hari*  — Rp 5.000\n` +
    `🔵 *5 Hari*  — Rp 10.000\n` +
    `🟣 *30 Hari* — Rp 20.000\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Hubungi admin: @${OWNER_USERNAME}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('💳 Beli Premium', `https://t.me/${OWNER_USERNAME}`)],
        [backBtn()],
      ]),
    }
  );
});

// ══════════════════════════════════════════════════════════════════
//  CANCEL STEP  &  BACK MAIN
// ══════════════════════════════════════════════════════════════════
async function goMainMenu(ctx) {
  initSession(ctx);
  ctx.session.step = null;
  ctx.session.groupLink = null;
  const userId = String(ctx.from.id);
  await ctx.editMessageText(
    `🤖 *ZangBot — Menu Utama*\n\n${statusText(userId)}`,
    { parse_mode: 'Markdown', ...mainMenu(userId) }
  );
}

bot.action('cancel_step', async (ctx) => { await ctx.answerCbQuery('Dibatalkan ✅'); await goMainMenu(ctx); });
bot.action('back_main',   async (ctx) => { await ctx.answerCbQuery(); await goMainMenu(ctx); });

// ══════════════════════════════════════════════════════════════════
//  TEXT HANDLER (multi-step)
// ══════════════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  initSession(ctx);
  const userId = String(ctx.from.id);
  const text   = ctx.message.text.trim();
  const step   = ctx.session.step;

  if (text.startsWith('/')) return;

  // ── STEP: aksi admin (premium, delete session, broadcast) ─────
  if (step === 'admin_awaiting_premium_id' && isAdmin(userId)) {
    const action = ctx.session.adminAction;
    ctx.session.step        = null;
    ctx.session.adminAction = null;

    // ── Beri premium ─────────────────────────────────────────────
    if (action === 'add_premium') {
      const parts    = text.trim().split(/\s+/);
      const targetId = parts[0];
      const days     = parseInt(parts[1]);

      if (!targetId || isNaN(days) || days < 1) {
        await ctx.reply(
          '❌ Format salah!\n\nContoh: `123456789 30`',
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
        );
        return;
      }

      getUser(targetId); // init jika belum ada
      const expiry = new Date(Date.now() + days * 86400000).toISOString();
      saveUser(targetId, { premium: true, premiumExpiry: expiry });

      const expiryStr = new Date(expiry).toLocaleDateString('id-ID', { dateStyle: 'long' });
      await ctx.reply(
        `✅ *Premium berhasil diberikan!*\n\n` +
        `👤 User ID : \`${targetId}\`\n` +
        `⭐ Durasi  : *${days} hari*\n` +
        `📅 Berakhir: *${expiryStr}*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
      );

      // Notifikasi ke user
      try {
        await bot.telegram.sendMessage(targetId,
          `🎉 *Selamat! Kamu mendapat akses Premium!*\n\n` +
          `⭐ Durasi  : *${days} hari*\n` +
          `📅 Berakhir: *${expiryStr}*\n\n` +
          `Terima kasih telah menggunakan ZangBot! 🤖`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
      return;
    }

    // ── Cabut premium ─────────────────────────────────────────────
    if (action === 'remove_premium') {
      const targetId = text.trim();
      const user     = getUser(targetId);

      if (!user.premium) {
        await ctx.reply(
          `⚠️ User \`${targetId}\` tidak memiliki premium aktif.`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
        );
        return;
      }

      saveUser(targetId, { premium: false, premiumExpiry: null });
      await ctx.reply(
        `✅ *Premium berhasil dicabut!*\n\n👤 User ID: \`${targetId}\``,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
      );

      try {
        await bot.telegram.sendMessage(targetId,
          `⚠️ *Akses Premium kamu telah berakhir.*\n\nHubungi admin untuk perpanjangan: @${OWNER_USERNAME}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
      return;
    }

    // ── Hapus session ─────────────────────────────────────────────
    if (action === 'delete_session') {
      const targetId = text.trim();
      await logoutWhatsApp(targetId);
      saveUser(targetId, { senderConnected: false });

      await ctx.reply(
        `✅ *Session berhasil dihapus!*\n\n👤 User ID: \`${targetId}\`\n\nUser tersebut sudah ter-logout dari WhatsApp.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
      );

      try {
        await bot.telegram.sendMessage(targetId,
          `⚠️ *Session WhatsApp kamu telah dihapus oleh admin.*\n\nSilakan login ulang jika ingin menggunakan bot.`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
      return;
    }

    // ── Broadcast ─────────────────────────────────────────────────
    if (action === 'broadcast') {
      const data    = loadData();
      const userIds = Object.keys(data.users);
      const msg     = text;

      const statusMsg = await ctx.reply(`📢 Mengirim broadcast ke *${userIds.length} user*...`, { parse_mode: 'Markdown' });

      let ok = 0, fail = 0;
      for (const uid of userIds) {
        try {
          await bot.telegram.sendMessage(uid,
            `📢 *Pesan dari Admin ZangBot*\n\n${msg}`,
            { parse_mode: 'Markdown' }
          );
          ok++;
          await sleep(300); // Anti-flood Telegram
        } catch {
          fail++;
        }
      }

      try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
      await ctx.reply(
        `✅ *Broadcast Selesai!*\n\n📤 Terkirim : *${ok}*\n❌ Gagal    : *${fail}*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin', 'admin_panel')]]) }
      );
      return;
    }
    return;
  }


  if (step === 'awaiting_phone_pairing') {
    const phone = text.replace(/[^0-9]/g, '');

    if (phone.length < 10 || phone.length > 15) {
      return ctx.reply(
        '❌ *Nomor tidak valid!*\n\nFormat: `628xxxxxxxxxx`\nContoh: `6281234567890`\n\nKirim ulang atau /batal',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[cancelBtn('❌ Batal')]]) }
      );
    }

    ctx.session.step = null;

    const waitMsg = await ctx.reply(
      '⏳ *Menghubungkan ke WhatsApp...*\n\nHarap tunggu, kode pairing akan segera muncul.',
      { parse_mode: 'Markdown' }
    );

    try {
      await connectWA({
        userId,
        mode: 'pairing',
        phoneNumber: phone,
        onPairingCode: async (rawCode) => {
          const formatted = String(rawCode)
            .replace(/[^A-Z0-9]/gi, '')
            .match(/.{1,4}/g)
            ?.join('-') || rawCode;

          try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}

          await ctx.replyWithMarkdown(
            `🎯 *Kode Pairing Berhasil Dibuat!*\n\n` +
            `🔢 *Kode kamu:*\n\n` +
            `\`\`\`\n${formatted}\n\`\`\`\n\n` +
            `📱 *Langkah memasukkan kode:*\n` +
            `1️⃣  Buka aplikasi WhatsApp\n` +
            `2️⃣  Ketuk ⋮  →  *Perangkat Tertaut*\n` +
            `3️⃣  Ketuk *Tautkan Perangkat*\n` +
            `4️⃣  Ketuk *Tautkan dengan nomor telepon*\n` +
            `5️⃣  Masukkan kode: \`${formatted}\`\n\n` +
            `⏱ Kode berlaku beberapa menit\n` +
            `⌛ Menunggu kamu memasukkan kode di HP...`
          );
        },
        onConnected: async () => {
          await ctx.replyWithMarkdown(
            '🎉 *Sender berhasil terhubung!*\n\n' +
            'WhatsApp kamu sudah aktif.\n' +
            'Sekarang kamu bisa pakai semua fitur ZangBot.',
            mainMenu(userId)
          );
        },
        onDisconnected: async (reason) => {
          try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}
          if (reason === 'PAIRING_FAILED') {
            await ctx.reply(
              '❌ *Gagal mendapatkan kode pairing.*\n\n' +
              'Kemungkinan penyebab:\n' +
              '• Nomor tidak terdaftar di WhatsApp\n' +
              '• Koneksi internet bermasalah\n' +
              '• Server WhatsApp sedang down\n\n' +
              'Silakan coba lagi.',
              { parse_mode: 'Markdown', ...mainMenu(userId) }
            );
          } else if (reason === 'LOGGED_OUT') {
            await ctx.reply('⚠️ Sesi habis. Silakan login ulang.', mainMenu(userId));
          }
        },
      });
    } catch (e) {
      console.error('[Pairing handler] error:', e?.message);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}
      await ctx.reply(
        '❌ *Terjadi error saat pairing.*\n\nCoba lagi.',
        { parse_mode: 'Markdown', ...mainMenu(userId) }
      );
    }
    return;
  }

  // ── STEP: link grup ───────────────────────────────────────────
  if (step === 'awaiting_group_link') {
    // Terima link invite ATAU langsung group JID (xxx@g.us)
    const isInviteLink = text.includes('chat.whatsapp.com/');
    const isGroupJid   = text.includes('@g.us');

    if (!isInviteLink && !isGroupJid) {
      return ctx.reply(
        '❌ Link tidak valid!\n\nKirim link grup WhatsApp:\n`https://chat.whatsapp.com/xxxxxxx`\n\nAtau /batal untuk keluar.',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[cancelBtn('❌ Batal')]]) }
      );
    }

    ctx.session.groupLink = text.trim();
    ctx.session.step = 'awaiting_puss_text';

    return ctx.reply(
      '✅ Link grup diterima!\n\n📝 Sekarang kirim *teks pesan* yang akan dikirim ke semua kontak:\n\n/batal untuk keluar.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[cancelBtn('❌ Batal')]]) }
    );
  }

  // ── STEP: teks pesan ──────────────────────────────────────────
  if (step === 'awaiting_puss_text') {
    const groupLink = ctx.session.groupLink;
    const pussText  = text; // FIX: simpan teks di variable tersendiri
    ctx.session.step = null;
    ctx.session.groupLink = null;

    if (!isConnected(userId))
      return ctx.reply('❌ Sender terputus! Login ulang dulu.', mainMenu(userId));

    const sock = waPool[userId]?.sock;
    if (!sock) return ctx.reply('❌ Koneksi tidak ditemukan.', mainMenu(userId));

    const statusMsg = await ctx.reply('⏳ Mengambil daftar kontak dari grup...');

    try {
      let groupJid = null;

      // ── Cara 1: Bot sudah di grup → pakai groupMetadata (paling akurat) ──
      // ── Cara 2: Dari link invite → pakai groupGetInviteInfo ───────────────

      if (groupLink.includes('@g.us')) {
        // Sudah berupa JID langsung
        groupJid = groupLink.trim();
      } else {
        // Ekstrak invite code dari link
        const inviteCode = groupLink.split('chat.whatsapp.com/')[1]?.replace(/[/?#].*/g, '').trim();
        if (!inviteCode) {
          try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
          return ctx.reply('❌ Link grup tidak valid.', mainMenu(userId));
        }

        // Coba ambil info via invite code untuk dapat group JID
        try {
          const inviteInfo = await sock.groupGetInviteInfo(inviteCode);
          groupJid = inviteInfo?.id || null;
        } catch (e) {
          console.error('[Puss] groupGetInviteInfo error:', e?.message);
        }

        // Jika gagal dapat JID dari invite info, coba join dulu lalu ambil metadata
        if (!groupJid) {
          try {
            groupJid = await sock.groupAcceptInvite(inviteCode);
            await sleep(2000);
          } catch (e) {
            console.error('[Puss] groupAcceptInvite error:', e?.message);
          }
        }
      }

      if (!groupJid) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
        return ctx.reply(
          '❌ Gagal mendapatkan info grup.\n\nPastikan:\n• Link grup valid\n• Bot sudah bergabung ke grup\n\nCoba kirim langsung Group JID (format: `123456789@g.us`)',
          { parse_mode: 'Markdown', ...mainMenu(userId) }
        );
      }

      // ── Ambil metadata lengkap via groupMetadata (dapat semua participant) ──
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        '⏳ Mengambil daftar member grup...',
        { parse_mode: 'Markdown' }
      );

      let meta;
      try {
        meta = await sock.groupMetadata(groupJid);
      } catch (e) {
        console.error('[Puss] groupMetadata error:', e?.message);
        try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
        return ctx.reply(
          '❌ Gagal mengambil data grup.\nPastikan bot sudah bergabung ke grup terlebih dahulu.',
          mainMenu(userId)
        );
      }

      // ── Filter participants: ambil nomor WA valid, abaikan LID ──────────────
      // Baileys baru kadang pakai format LID (xxx@lid) — harus normalisasi
      const rawParticipants = meta.participants || [];
      const participants = rawParticipants
        .map(p => {
          // Prioritas: p.jid (nomor HP), lalu p.id jika bukan LID
          const jid = p.jid || p.id;
          if (!jid) return null;
          if (jid.includes('@lid')) return null;  // skip LID, tidak bisa dikirimi pesan
          if (jid.includes('@g.us')) return null; // skip group JID
          if (!jid.includes('@s.whatsapp.net')) {
            // Normalisasi: tambahkan suffix jika belum ada
            return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
          }
          return jid;
        })
        .filter(Boolean);

      if (participants.length === 0) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
        return ctx.reply(
          `❌ Tidak ada kontak yang bisa dikirim pesan.\n\nTotal member di grup: ${rawParticipants.length}\n(Semua menggunakan format LID yang tidak didukung)`,
          mainMenu(userId)
        );
      }

      // ── Mulai kirim ──────────────────────────────────────────────────────────
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        `📨 *Memulai Puss Kontak*\n\n` +
        `👥 Total kontak: *${participants.length}*\n` +
        `📝 Grup: *${meta.subject || groupJid}*\n\n` +
        `⏳ Mengirim... (0/${participants.length})`,
        { parse_mode: 'Markdown' }
      );

      let sent = 0, failed = 0;
      const updateInterval = Math.max(1, Math.floor(participants.length / 10)); // update setiap ~10%

      for (let i = 0; i < participants.length; i++) {
        const jid = participants[i];
        try {
          await sock.sendMessage(jid, { text: pussText }); // FIX: pakai pussText bukan text
          sent++;
        } catch (e) {
          console.error(`[Puss] Failed to send to ${jid}: ${e?.message}`);
          failed++;
        }

        // Update progress setiap beberapa pesan
        if ((i + 1) % updateInterval === 0 || i === participants.length - 1) {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id, statusMsg.message_id, null,
              `📨 *Sedang Mengirim...*\n\n` +
              `✅ Terkirim : *${sent}*\n` +
              `❌ Gagal    : *${failed}*\n` +
              `📊 Progress : *${i + 1}/${participants.length}*`,
              { parse_mode: 'Markdown' }
            );
          } catch {}
        }

        // Delay anti-spam: 2-4 detik antar pesan
        if (i < participants.length - 1) {
          await sleep(2000 + Math.random() * 2000);
        }
      }

      // ── Selesai ──────────────────────────────────────────────────────────────
      try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
      await ctx.replyWithMarkdown(
        `✅ *Puss Kontak Selesai!*\n\n` +
        `👥 Grup      : *${meta.subject || groupJid}*\n` +
        `📤 Terkirim  : *${sent}*\n` +
        `❌ Gagal     : *${failed}*\n` +
        `📊 Total     : *${participants.length}*`,
        mainMenu(userId)
      );

    } catch (e) {
      console.error('[Puss kontak] error:', e?.message);
      try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
      await ctx.reply(
        `❌ Error: ${e?.message || 'Unknown error'}\n\nPastikan bot sudah bergabung ke grup.`,
        mainMenu(userId)
      );
    }
    return;
  }

  // ── Default ──────────────────────────────────────────────────
  await ctx.replyWithMarkdown(
    `📋 *Menu Utama ZangBot*\n\n${statusText(userId)}`,
    mainMenu(userId)
  );
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN GUARD MIDDLEWARE
// ══════════════════════════════════════════════════════════════════
function adminOnly(handler) {
  return async (ctx, ...args) => {
    if (!isAdmin(ctx.from?.id)) {
      try { await ctx.answerCbQuery('⛔ Akses ditolak!', { show_alert: true }); } catch {}
      return;
    }
    return handler(ctx, ...args);
  };
}

// ══════════════════════════════════════════════════════════════════
//  ADMIN PANEL UTAMA
// ══════════════════════════════════════════════════════════════════
function adminPanelMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Lihat Semua User',       'admin_list_users')],
    [Markup.button.callback('⭐ Beri Premium User',       'admin_add_premium')],
    [Markup.button.callback('❌ Cabut Premium User',      'admin_remove_premium')],
    [Markup.button.callback('📊 Statistik Bot',           'admin_stats')],
    [Markup.button.callback('📢 Broadcast Pesan',         'admin_broadcast')],
    [Markup.button.callback('🗑️ Hapus Session User',      'admin_delete_session')],
    [Markup.button.callback('🔙 Kembali ke Menu',         'back_main')],
  ]);
}

bot.action('admin_panel', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  const data  = loadData();
  const total = Object.keys(data.users).length;
  const prem  = Object.values(data.users).filter(u => isPremiumActive(u.id)).length;
  const conn  = Object.keys(waPool).filter(id => isConnected(id)).length;

  await ctx.editMessageText(
    `🛡️ *Panel Admin ZangBot*\n\n` +
    `👤 Total User    : *${total}*\n` +
    `⭐ User Premium  : *${prem}*\n` +
    `🟢 WA Terhubung : *${conn}*\n\n` +
    `Pilih aksi di bawah:`,
    { parse_mode: 'Markdown', ...adminPanelMenu() }
  );
}));

// ── Statistik ────────────────────────────────────────────────────
bot.action('admin_stats', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  const data   = loadData();
  const users  = Object.values(data.users);
  const total  = users.length;
  const prem   = users.filter(u => isPremiumActive(u.id)).length;
  const conn   = Object.keys(waPool).filter(id => isConnected(id)).length;
  const today  = new Date().toLocaleDateString('id-ID', { dateStyle: 'full' });

  await ctx.editMessageText(
    `📊 *Statistik Bot — ${today}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 Total User Terdaftar : *${total}*\n` +
    `⭐ User Premium Aktif   : *${prem}*\n` +
    `🔒 User Non-Premium     : *${total - prem}*\n` +
    `🟢 WA Sedang Terhubung : *${conn}*\n` +
    `━━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Kembali ke Admin', 'admin_panel')],
      ]),
    }
  );
}));

// ── List semua user ──────────────────────────────────────────────
bot.action('admin_list_users', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  const data  = loadData();
  const users = Object.values(data.users);

  if (users.length === 0) {
    return ctx.editMessageText(
      '👤 Belum ada user terdaftar.',
      { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', 'admin_panel')]]) }
    );
  }

  // Tampilkan max 30 user agar tidak melebihi batas Telegram
  const list = users.slice(0, 30).map((u, i) => {
    const prem    = isPremiumActive(u.id) ? '⭐' : '🔒';
    const status  = isConnected(String(u.id)) ? '🟢' : '🔴';
    const expiry  = u.premiumExpiry
      ? new Date(u.premiumExpiry).toLocaleDateString('id-ID')
      : '-';
    return `${i + 1}. ID: \`${u.id}\` ${prem} ${status}\n    Premium: ${expiry}`;
  }).join('\n\n');

  const extra = users.length > 30 ? `\n\n_...dan ${users.length - 30} user lainnya_` : '';

  await ctx.editMessageText(
    `👤 *Daftar User (${users.length} total)*\n\n${list}${extra}\n\n` +
    `🟢 = WA terhubung | ⭐ = Premium aktif`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Kembali ke Admin', 'admin_panel')],
      ]),
    }
  );
}));

// ── Beri premium ─────────────────────────────────────────────────
bot.action('admin_add_premium', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  ctx.session.step        = 'admin_awaiting_premium_id';
  ctx.session.adminAction = 'add_premium';

  await ctx.editMessageText(
    `⭐ *Beri Premium ke User*\n\n` +
    `Kirim dalam format:\n` +
    `\`USER_ID DURASI\`\n\n` +
    `Contoh:\n` +
    `\`123456789 3\` → premium 3 hari\n` +
    `\`123456789 30\` → premium 30 hari\n\n` +
    `❌ Tekan Batal untuk keluar.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Batal', 'admin_panel')],
      ]),
    }
  );
}));

// ── Cabut premium ────────────────────────────────────────────────
bot.action('admin_remove_premium', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  ctx.session.step        = 'admin_awaiting_premium_id';
  ctx.session.adminAction = 'remove_premium';

  await ctx.editMessageText(
    `❌ *Cabut Premium User*\n\n` +
    `Kirim ID user yang ingin dicabut premiumnya:\n\n` +
    `Contoh: \`123456789\`\n\n` +
    `❌ Tekan Batal untuk keluar.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Batal', 'admin_panel')],
      ]),
    }
  );
}));

// ── Hapus session user ───────────────────────────────────────────
bot.action('admin_delete_session', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  ctx.session.step        = 'admin_awaiting_premium_id';
  ctx.session.adminAction = 'delete_session';

  await ctx.editMessageText(
    `🗑️ *Hapus Session User*\n\n` +
    `Kirim ID user yang sessionnya ingin dihapus:\n\n` +
    `Contoh: \`123456789\`\n\n` +
    `⚠️ User tersebut akan ter-logout dari WhatsApp.\n\n` +
    `❌ Tekan Batal untuk keluar.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Batal', 'admin_panel')],
      ]),
    }
  );
}));

// ── Broadcast ────────────────────────────────────────────────────
bot.action('admin_broadcast', adminOnly(async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx);
  ctx.session.step        = 'admin_awaiting_premium_id';
  ctx.session.adminAction = 'broadcast';

  await ctx.editMessageText(
    `📢 *Broadcast Pesan ke Semua User*\n\n` +
    `Kirim teks pesan yang ingin di-broadcast:\n\n` +
    `⚠️ Pesan akan dikirim ke semua user terdaftar.\n\n` +
    `❌ Tekan Batal untuk keluar.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Batal', 'admin_panel')],
      ]),
    }
  );
}));

// ══════════════════════════════════════════════════════════════════
//  ERROR HANDLER
// ══════════════════════════════════════════════════════════════════
bot.catch((err, ctx) => {
  console.error('[Bot error]', err?.message || err);
  try { ctx.reply('❌ Terjadi error. Coba lagi atau ketik /menu'); } catch {}
});

// ══════════════════════════════════════════════════════════════════
//  LAUNCH
// ══════════════════════════════════════════════════════════════════
bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ ZangBot running...'))
  .catch(console.error);

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
