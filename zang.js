// ============= PREMIUM VCF BOT - NODE.JS VERSION (FULL BUTTON UI) =============
// Semua fitur diakses lewat tombol, tanpa perintah /command
// Jalankan: node zang.js

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const Database   = require('better-sqlite3');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');

// ============= KONFIGURASI =============
const BOT_TOKEN          = '8012579180:AAE-MqM151HprLTCBAJUFS5CpLv3U_csNT4';
const ADMIN_IDS          = [8496726839, 987654321];
const FORCE_JOIN_GROUP   = '';
const FORCE_JOIN_CHANNEL = '';
const CEO_USERNAME       = '@XIXI8778';
const DB_FILE            = 'bot_database.db';
const TEMP_FOLDER        = 'temp_files';

const COIN_PACKAGES = {
  '2day':  { days: 2,  coins: 5  },
  '5day':  { days: 5,  coins: 10 },
  '40day': { days: 40, coins: 50 },
};

// ============= PAYMENT =============
const pay = require('./payment');
const PLANS = {
  p5:   { id:'p5',   nama:'VIP 5 Hari',    harga:2000,  hari:5,   },
  p30:  { id:'p30',  nama:'VIP 30 Hari',   harga:10000, hari:30,  },
  pPerm:{ id:'pPerm',nama:'VIP Permanen',  harga:50000, hari:36500 },
};
const invoicePollers = {}; // simpan interval poll per user

if (!fs.existsSync(TEMP_FOLDER)) fs.mkdirSync(TEMP_FOLDER, { recursive: true });

// ============= MULTI-LANGUAGE =============
const LANGUAGES = {
  id: {
    welcome       : 'Halo {name}, selamat datang! 👋',
    btn_tovcf     : '🔄 TXT → VCF',
    btn_totxt     : '🔄 VCF → TXT',
    btn_manual    : '✏️ Input Manual',
    btn_add       : '➕ Tambah Kontak',
    btn_delete    : '🗑️ Hapus Kontak',
    btn_renamectc : '📝 Ganti Nama Kontak',
    btn_renamefile: '🏷️ Ganti Nama File',
    btn_merge     : '🔗 Gabung File',
    btn_split     : '✂️ Pecah File',
    btn_nodup     : '🧹 Hapus Duplikat',
    btn_count     : '🔢 Hitung Kontak',
    btn_getconten : '📖 Lihat Isi File',
    btn_status    : '👤 Status Akun',
    btn_vip       : '💎 Paket Premium',
    btn_referral  : '👥 Referral',
    btn_lang      : '🌐 Ganti Bahasa',
    btn_back      : '⬅️ Kembali',
    btn_done      : '✅ Selesai',
    btn_cancel    : '❌ Batal',
    btn_admin     : '🔐 Panel Admin',
    must_join     : '⚠️ Anda harus join Group dan Channel dulu!',
    join_group    : '📢 Join Group',
    join_channel  : '📣 Join Channel',
    check_join    : '✅ Saya Sudah Join',
    not_joined    : '❌ Anda belum join!\n\nSilakan join dulu lalu klik "Saya Sudah Join".',
    vip_required  : '⚠️ *Fitur Premium*\n\nFree trial Anda habis!\nUpgrade ke Premium untuk melanjutkan.',
    send_file     : '📄 Silakan kirim file',
    lang_select   : '🌐 Pilih Bahasa',
    lang_changed  : '✅ Bahasa diubah ke Indonesia',
    total_contacts: '📊 Total kontak: {count}',
    total_lines   : '📊 Total baris: {count}',
  },
  en: {
    welcome       : 'Hello {name}, welcome! 👋',
    btn_tovcf     : '🔄 TXT → VCF',
    btn_totxt     : '🔄 VCF → TXT',
    btn_manual    : '✏️ Manual Input',
    btn_add       : '➕ Add Contact',
    btn_delete    : '🗑️ Delete Contact',
    btn_renamectc : '📝 Rename Contact',
    btn_renamefile: '🏷️ Rename File',
    btn_merge     : '🔗 Merge Files',
    btn_split     : '✂️ Split File',
    btn_nodup     : '🧹 Remove Duplicates',
    btn_count     : '🔢 Count Contacts',
    btn_getconten : '📖 View File Content',
    btn_status    : '👤 Account Status',
    btn_vip       : '💎 Premium Packages',
    btn_referral  : '👥 Referral',
    btn_lang      : '🌐 Change Language',
    btn_back      : '⬅️ Back',
    btn_done      : '✅ Done',
    btn_cancel    : '❌ Cancel',
    btn_admin     : '🔐 Admin Panel',
    must_join     : '⚠️ You must join the Group and Channel first!',
    join_group    : '📢 Join Group',
    join_channel  : '📣 Join Channel',
    check_join    : '✅ I Have Joined',
    not_joined    : '❌ You have not joined!\n\nPlease join first then click "I Have Joined".',
    vip_required  : '⚠️ *Premium Feature*\n\nYour free trial expired!\nUpgrade to Premium to continue.',
    send_file     : '📄 Please send file',
    lang_select   : '🌐 Select Language',
    lang_changed  : '✅ Language changed to English',
    total_contacts: '📊 Total contacts: {count}',
    total_lines   : '📊 Total lines: {count}',
  },
};

// ============= DATABASE =============
class Db {
  constructor() {
    this.db = new Database(DB_FILE);
    this.createTables();
  }
  createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT, first_name TEXT,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        vip_until TIMESTAMP,
        coins INTEGER DEFAULT 0,
        referred_by INTEGER,
        is_active INTEGER DEFAULT 1,
        language TEXT DEFAULT 'id'
      );
      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id INTEGER, referred_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try { this.db.prepare("SELECT language FROM users LIMIT 1").get(); }
    catch (e) { try { this.db.exec("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'id'"); } catch (_) {} }
  }
  addUser(uid, username, firstName, ref = null) {
    if (this.db.prepare('SELECT user_id FROM users WHERE user_id=?').get(uid)) return false;
    const trial = new Date(Date.now() + 12 * 3600000).toISOString();
    this.db.prepare(`INSERT INTO users (user_id,username,first_name,vip_until,referred_by,language) VALUES (?,?,?,?,?,'id')`).run(uid, username, firstName, trial, ref);
    if (ref) {
      this.db.prepare('INSERT INTO referrals (referrer_id,referred_id) VALUES (?,?)').run(ref, uid);
      this.db.prepare('UPDATE users SET coins=coins+1 WHERE user_id=?').run(ref);
    }
    return true;
  }
  getLang(uid)     { try { const r=this.db.prepare('SELECT language FROM users WHERE user_id=?').get(uid); return (r&&r.language)||'id'; } catch(e){ return 'id'; } }
  setLang(uid,l)   { try { this.db.prepare('UPDATE users SET language=? WHERE user_id=?').run(l,uid); } catch(e){} }
  isVip(uid)       { const r=this.db.prepare('SELECT vip_until FROM users WHERE user_id=?').get(uid); return !!(r&&r.vip_until&&new Date(r.vip_until)>new Date()); }
  getUser(uid)     { return this.db.prepare('SELECT * FROM users WHERE user_id=?').get(uid)||null; }
  addVipDays(uid,days) {
    const r=this.db.prepare('SELECT vip_until FROM users WHERE user_id=?').get(uid);
    const base=(r&&r.vip_until&&new Date(r.vip_until)>new Date())?new Date(r.vip_until):new Date();
    const nv=new Date(base.getTime()+days*86400000);
    this.db.prepare('UPDATE users SET vip_until=? WHERE user_id=?').run(nv.toISOString(),uid);
    return nv;
  }
  useCoins(uid,amt){ const r=this.db.prepare('SELECT coins FROM users WHERE user_id=?').get(uid); if(!r||r.coins<amt) return false; this.db.prepare('UPDATE users SET coins=coins-? WHERE user_id=?').run(amt,uid); return true; }
  getAllUsers()    { return this.db.prepare('SELECT * FROM users ORDER BY registered_at DESC').all(); }
  getActive()     { return this.db.prepare('SELECT user_id FROM users WHERE is_active=1').all().map(r=>r.user_id); }
  deactivate(uid) { this.db.prepare('UPDATE users SET is_active=0 WHERE user_id=?').run(uid); }
  getRefs(uid)    { return this.db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id=?').get(uid).c; }
  getStats()      { return { total: this.db.prepare('SELECT COUNT(*) as c FROM users').get().c, vip: this.db.prepare("SELECT COUNT(*) as c FROM users WHERE vip_until>datetime('now')").get().c, refs: this.db.prepare('SELECT COUNT(*) as c FROM referrals').get().c }; }
}

const db = new Db();
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ============= SESSION =============
const sessions = {};
const timers = {}; // auto-detect timer per user
const pending = {}; // pending download counter per user
const sess  = uid => { if (!sessions[uid]) sessions[uid]={state:null,data:{}}; return sessions[uid]; };
const clear = uid => { sessions[uid]={state:null,data:{}}; };
const setState = (uid,s) => { sess(uid).state=s; };
const getState = uid => sess(uid).state;
const setD = (uid,k,v) => { sess(uid).data[k]=v; };
const getD = (uid,k) => sess(uid).data[k];

const S = {
  MAN_NUMS:'MAN_NUMS', MAN_NAME:'MAN_NAME', MAN_FNAME:'MAN_FNAME',
  ADD_NUMS:'ADD_NUMS', ADD_NAME:'ADD_NAME', ADD_FNAME:'ADD_FNAME',
  DEL_FILE:'DEL_FILE', DEL_PAT:'DEL_PAT',
  RNC_FILE:'RNC_FILE', RNC_NEW:'RNC_NEW',
  RNF_FILE:'RNF_FILE', RNF_NAME:'RNF_NAME', RNF_DONE:'RNF_DONE',
  MERGE:'MERGE', NODUP:'NODUP', TOTXT:'TOTXT',
  MERGE_FNAME:'MERGE_FNAME', NODUP_FNAME:'NODUP_FNAME', TOTXT_FNAME:'TOTXT_FNAME',
  GETCONTEN:'GETCONTEN', GETCONTENT:'GETCONTENT',
  TOVCF_FILE:'TOVCF_FILE', TOVCF_NAME:'TOVCF_NAME', TOVCF_FNAME:'TOVCF_FNAME', TOVCF_LIM:'TOVCF_LIM', TOVCF_CNAME:'TOVCF_CNAME',
  SPL_FILE:'SPL_FILE', SPL_CNT:'SPL_CNT',
  COUNT:'COUNT',
  ADM_MSG:'ADM_MSG', ADM_ADDID:'ADM_ADDID', ADM_ADDDAYS:'ADM_ADDDAYS', ADM_STOPID:'ADM_STOPID',
};

// ============= UTILS =============
const isAdmin   = uid => ADMIN_IDS.includes(uid);
const T = (uid,k,vars={}) => { const l=db.getLang(uid)||'id'; const L=LANGUAGES[l]||LANGUAGES.id; let t=L[k]||k; for(const[a,b]of Object.entries(vars)) t=t.replace(`{${a}}`,b); return t; };
const rmFile    = fp => { try { if(fp&&fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e){} };
const cleanPhone= n => n.replace(/\D/g,'');
const mkVcard   = (name,phone,idx=null) => { const c=cleanPhone(phone); if(!c) return ''; return `BEGIN:VCARD\nVERSION:3.0\nFN:${idx!==null?`${name} ${String(idx).padStart(3,'0')}`:name}\nTEL;TYPE=CELL:+${c}\nEND:VCARD\n`; };
const getVcards = txt => txt.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi)||[];
const getPhones = txt => { const p=[]; for(const re of [/TEL[^:]*:[\+]?([0-9]+)/gi,/item\d+\.TEL[^:]*:[\+]?([0-9]+)/gi]){let m; while((m=re.exec(txt))!==null) if(!p.includes(m[1])) p.push(m[1]);} return [...new Set(p)]; };
const dedup     = list => { const seen=new Set(),u=[]; for(const v of list){const p=getPhones(v);if(p.length&&!seen.has(p[0])){seen.add(p[0]);u.push(v);}} return u; };

async function dlFile(fileId, savePath) {
  const info = await bot.getFile(fileId);
  const url  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
  return new Promise((res,rej) => {
    const f = fs.createWriteStream(savePath);
    https.get(url, r => { r.pipe(f); f.on('finish', ()=>{ f.close(); res(); }); }).on('error', e=>{ fs.unlink(savePath,()=>{}); rej(e); });
  });
}

async function checkMember(uid) {
  const ok = ['member','administrator','creator','restricted'];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const gm = await bot.getChatMember(FORCE_JOIN_GROUP, uid);
      const cm = await bot.getChatMember(FORCE_JOIN_CHANNEL, uid);
      if (ok.includes(gm.status) && ok.includes(cm.status)) return true;
      // Jika salah satu belum join, cek mana yang belum
      return { group: ok.includes(gm.status), channel: ok.includes(cm.status) };
    } catch(e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

async function showForceJoin(chatId, uid, status = null) {
  const t = LANGUAGES[db.getLang(uid)]||LANGUAGES.id;
  let msg = t.must_join;
  if (status && typeof status === 'object') {
    const groupIcon  = status.group   ? '✅' : '❌';
    const chanIcon   = status.channel ? '✅' : '❌';
    msg = `⚠️ *Wajib Join dulu!*\n\n${groupIcon} Group: ${status.group ? 'Sudah join' : 'Belum join'}\n${chanIcon} Channel: ${status.channel ? 'Sudah join' : 'Belum join'}`;
  }
  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
    [{ text: t.join_group,   url: `https://t.me/${FORCE_JOIN_GROUP.slice(1)}` }],
    [{ text: t.join_channel, url: `https://t.me/${FORCE_JOIN_CHANNEL.slice(1)}` }],
    [{ text: t.check_join,   callback_data: 'check_membership' }]
  ]}});
}

// files = array of { path, name }
// Rename file ke nama final di temp folder, kirim dengan ReadStream (nama dari path)
async function sendFiles(chatId, files) {
  if (!files.length) return;

  // Rename semua ke nama final - pakai subfolder unik agar tidak konflik
  const ts = Date.now();
  const finalPaths = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Simpan di subfolder temp unik: temp_files/send_<ts>/<nama>.ext
    const dir = `${TEMP_FOLDER}/send_${ts}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const finalPath = `${dir}/${f.name}`;
    try {
      fs.copyFileSync(f.path, finalPath);
      rmFile(f.path);
      finalPaths.push(finalPath);
    } catch(e) {
      console.error('copy error:', e.message);
      rmFile(f.path);
    }
  }

  if (!finalPaths.length) { await bot.sendMessage(chatId, '❌ Gagal memproses file'); return; }

  const cleanup = () => {
    for (const p of finalPaths) rmFile(p);
    try { fs.rmdirSync(`${TEMP_FOLDER}/send_${ts}`); } catch(e){}
  };

  if (finalPaths.length === 1) {
    try { await bot.sendDocument(chatId, fs.createReadStream(finalPaths[0]), { caption: '✅ Selesai!' }, { filename: finalPaths[0].split('/').pop(), contentType: 'application/octet-stream' }); }
    finally { cleanup(); }
    return;
  }

  const MAX = 10, batches = Math.ceil(finalPaths.length / MAX);
  await bot.sendMessage(chatId, `📤 Mengirim ${finalPaths.length} file dalam ${batches} batch...`);

  for (let i = 0; i < finalPaths.length; i += MAX) {
    const batch = finalPaths.slice(i, i + MAX);
    const bn = Math.floor(i / MAX) + 1;
    try {
      const media = batch.map((fp, idx) => ({
        type: 'document',
        media: fs.createReadStream(fp),
        ...(i === 0 && idx === 0 ? { caption: `✅ Total ${finalPaths.length} file` } : {})
      }));
      await bot.sendMediaGroup(chatId, media);
      if (batches > 1) await bot.sendMessage(chatId, `📦 Batch ${bn}/${batches} selesai`);
      if (i + MAX < finalPaths.length) await new Promise(r => setTimeout(r, 1000));
    } catch(e) {
      console.error('mediaGroup error:', e.message);
      for (const fp of batch) {
        try { await bot.sendDocument(chatId, fs.createReadStream(fp), {}, { filename: fp.split('/').pop(), contentType: 'application/octet-stream' }); await new Promise(r=>setTimeout(r,400)); } catch(e2){}
      }
    }
  }
  cleanup();
}

// Kirim satu file dengan nama yang benar
async function sendFileNamed(chatId, tmpPath, finalName, captionText) {
  const dir = `${TEMP_FOLDER}/send_${Date.now()}`;
  const finalPath = `${dir}/${finalName}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(tmpPath, finalPath);
    rmFile(tmpPath);
    await bot.sendDocument(chatId, fs.createReadStream(finalPath), captionText ? { caption: captionText } : {}, { filename: finalName, contentType: 'application/octet-stream' });
  } finally {
    rmFile(finalPath);
    try { fs.rmdirSync(dir); } catch(e){}
  }
}

// ============= MULTI FILE COLLECTOR =============
// Kumpulkan file dari user, deteksi selesai pakai pending counter + timer
// onDone(chatId, uid, files) dipanggil saat semua file selesai didownload
function collectFiles(chatId, uid, fileId, ext, origName, storageKey, statusMsgId, labelText, onDone) {
  // Increment pending
  pending[uid] = (pending[uid] || 0) + 1;

  // Reset timer setiap ada file masuk
  if (timers[uid]) clearTimeout(timers[uid]);

  // Download dulu, baru proses
  const fp = `${TEMP_FOLDER}/dl_${uid}_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  dlFile(fileId, fp).then(() => {
    const files = getD(uid, storageKey) || [];
    files.push({ path: fp, ext, origName });
    setD(uid, storageKey, files);

    // Decrement pending
    pending[uid] = Math.max(0, (pending[uid] || 1) - 1);

    // Update status message
    try {
      bot.editMessageText(
        `${labelText}\n\n✅ *${files.length} file* diterima...\n⏳ Tunggu sebentar setelah kirim semua file.`,
        { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'back_main' }]] } }
      ).catch(() => {});
    } catch(e) {}

    // Set timer setelah download selesai - tunggu sampai semua pending = 0
    if (timers[uid]) clearTimeout(timers[uid]);
    timers[uid] = setTimeout(async () => {
      // Cek masih ada pending download?
      if ((pending[uid] || 0) > 0) {
        // Masih ada yang download, tunda lagi
        timers[uid] = setTimeout(async () => {
          delete timers[uid];
          delete pending[uid];
          const allFiles = getD(uid, storageKey) || [];
          onDone(chatId, uid, allFiles);
        }, 1500);
        return;
      }
      delete timers[uid];
      delete pending[uid];
      const allFiles = getD(uid, storageKey) || [];
      onDone(chatId, uid, allFiles);
    }, 1500);
  }).catch(e => {
    pending[uid] = Math.max(0, (pending[uid] || 1) - 1);
    console.error('download error:', e.message);
  });
}

// ============= KEYBOARD BUILDERS =============
function mainKb(uid) {
  const t = LANGUAGES[db.getLang(uid)]||LANGUAGES.id;
  const kb = [
    [{ text:t.btn_tovcf,    callback_data:'f_tovcf'    }, { text:t.btn_totxt,     callback_data:'f_totxt'     }],
    [{ text:t.btn_manual,   callback_data:'f_manual'   }, { text:t.btn_add,        callback_data:'f_add'       }],
    [{ text:t.btn_delete,   callback_data:'f_delete'   }, { text:t.btn_renamectc,  callback_data:'f_renamectc' }],
    [{ text:t.btn_renamefile,callback_data:'f_renamefile'},{ text:t.btn_merge,     callback_data:'f_merge'     }],
    [{ text:t.btn_split,    callback_data:'f_split'    }, { text:t.btn_nodup,      callback_data:'f_nodup'     }],
    [{ text:t.btn_count,    callback_data:'f_count'    }, { text:t.btn_getconten,  callback_data:'f_getconten' }],
    [{ text:t.btn_status,   callback_data:'f_status'   }, { text:t.btn_vip,        callback_data:'f_vip'       }],
    [{ text:t.btn_referral, callback_data:'f_referral' }, { text:t.btn_lang,       callback_data:'f_lang'      }],
  ];
  if (isAdmin(uid)) kb.push([{ text:t.btn_admin, callback_data:'f_admin' }]);
  return { inline_keyboard: kb };
}

const backKb   = uid => ({ inline_keyboard: [[{ text:T(uid,'btn_back'), callback_data:'back_main' }]] });
const cancelKb = uid => ({ inline_keyboard: [[{ text:T(uid,'btn_cancel'), callback_data:'back_main' }]] });
const doneKb   = (uid, doneCb) => ({ inline_keyboard: [
  [{ text:T(uid,'btn_done'), callback_data:doneCb }, { text:T(uid,'btn_cancel'), callback_data:'back_main' }]
]});

async function sendMain(chatId, uid, name) {
  const t = LANGUAGES[db.getLang(uid)]||LANGUAGES.id;
  await bot.sendMessage(chatId, `${t.welcome.replace('{name}',name||'')}\n\n*Pilih fitur:*`, { parse_mode:'Markdown', reply_markup:mainKb(uid) });
}
async function editMain(chatId, msgId, uid, name) {
  const t = LANGUAGES[db.getLang(uid)]||LANGUAGES.id;
  try { await bot.editMessageText(`${t.welcome.replace('{name}',name||'')}\n\n*Pilih fitur:*`, { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:mainKb(uid) }); } catch(e){}
}

function vipOk(chatId, uid) {
  if (isAdmin(uid)||db.isVip(uid)) return true;
  bot.sendMessage(chatId, T(uid,'vip_required'), { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{ text:'💎 Lihat Paket', callback_data:'f_vip' }]]} });
  return false;
}

// ============= /start =============
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  // Hanya respon di private chat
  if (msg.chat.type !== 'private') {
    try { await bot.sendMessage(msg.chat.id, '📩 Hubungi bot di pribadi ya Dear🥰', { reply_to_message_id: msg.message_id }); } catch(e){}
    return;
  }
  const chatId=msg.chat.id, uid=msg.from.id;
  let ref=null;
  if (match&&match[1]&&match[1].startsWith('ref')) { const r=parseInt(match[1].slice(3)); if(!isNaN(r)) ref=r; }
  db.addUser(uid, msg.from.username||'', msg.from.first_name||'', ref);
  if (!isAdmin(uid)) {
    const memberStatus = await checkMember(uid);
    if (memberStatus !== true) { await showForceJoin(chatId, uid, memberStatus); return; }
  }
  clear(uid);
  await sendMain(chatId, uid, msg.from.first_name);
});

// ============= CALLBACK HANDLER =============
bot.on('callback_query', async (query) => {
  // Hanya proses callback dari private chat
  if (query.message.chat.type !== 'private') {
    await bot.answerCallbackQuery(query.id, { text: '📩 Gunakan bot di chat pribadi ya Dear🥰', show_alert: true }).catch(()=>{});
    return;
  }
  const chatId=query.message.chat.id, msgId=query.message.message_id;
  const uid=query.from.id, data=query.data;
  await bot.answerCallbackQuery(query.id).catch(()=>{});

  // BACK / CANCEL → Main Menu
  if (data==='back_main') { clear(uid); await editMain(chatId,msgId,uid,query.from.first_name); return; }

  // CHECK MEMBERSHIP
  if (data==='check_membership') {
    await bot.answerCallbackQuery(query.id, { text: '🔍 Mengecek keanggotaan...' });
    // Edit pesan jadi loading dulu
    try {
      await bot.editMessageText(
        '🔍 *Sedang mengecek keanggotaan...*\nMohon tunggu sebentar.',
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      );
    } catch(e){}

    const memberStatus = await checkMember(uid);
    const t = LANGUAGES[db.getLang(uid)]||LANGUAGES.id;

    if (memberStatus === true) {
      // Sudah join semua - berikan akses
      try {
        await bot.editMessageText(
          '✅ *Verifikasi berhasil!*\nSelamat datang! Mengalihkan ke menu...',
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch(e){}
      await new Promise(r => setTimeout(r, 1000));
      await sendMain(chatId, uid, query.from.first_name);
    } else {
      // Belum join - tampilkan status detail
      const groupIcon  = (memberStatus && memberStatus.group)   ? '✅' : '❌';
      const chanIcon   = (memberStatus && memberStatus.channel) ? '✅' : '❌';
      const msg = `⚠️ *Belum bergabung semua!*\n\n${groupIcon} Group: ${memberStatus && memberStatus.group ? 'Sudah join' : 'Belum join'}\n${chanIcon} Channel: ${memberStatus && memberStatus.channel ? 'Sudah join' : 'Belum join'}\n\nSilakan join lalu klik tombol cek lagi.`;
      try {
        await bot.editMessageText(msg, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: t.join_group,   url: `https://t.me/${FORCE_JOIN_GROUP.slice(1)}` }],
            [{ text: t.join_channel, url: `https://t.me/${FORCE_JOIN_CHANNEL.slice(1)}` }],
            [{ text: '🔄 Cek Lagi', callback_data: 'check_membership' }]
          ]}
        });
      } catch(e){}
    }
    return;
  }

  // LANGUAGE
  if (data==='f_lang') {
    await bot.editMessageText(T(uid,'lang_select'), { chat_id:chatId, message_id:msgId, reply_markup:{ inline_keyboard:[
      [{ text:'🇮🇩 Indonesia', callback_data:'lang_id' }],
      [{ text:'🇬🇧 English',   callback_data:'lang_en' }],
      [{ text:T(uid,'btn_back'), callback_data:'back_main' }]
    ]}});
    return;
  }
  if (data.startsWith('lang_')) {
    const lc=data.slice(5);
    if (LANGUAGES[lc]) { db.setLang(uid,lc); await bot.editMessageText(LANGUAGES[lc].lang_changed,{chat_id:chatId,message_id:msgId}); }
    return;
  }

  // STATUS
  if (data==='f_status') {
    const u=db.getUser(uid); if(!u) return;
    const vu=new Date(u.vip_until), vip=vu>new Date();
    let vs;
    if (vip) { const d=Math.floor((vu-new Date())/86400000); vs=d>0?`✅ Premium\nSisa: ${d} hari`:`✅ Premium\nSisa: ${Math.floor(((vu-new Date())%86400000)/3600000)} jam`; }
    else vs='❌ Expired';
    await bot.editMessageText(
      `👤 *STATUS AKUN*\n\nNama: ${u.first_name}\nID: \`${uid}\`\nStatus: ${vs}\n\n💰 Koin: ${u.coins}\n👥 Referral: ${db.getRefs(uid)}`,
      { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'⬆️ Upgrade VIP', callback_data:'f_vip' },{ text:'💰 Tukar Koin', callback_data:'exc_menu' }],
        [{ text:T(uid,'btn_back'), callback_data:'back_main' }]
      ]}}
    );
    return;
  }

  // VIP
  if (data==='f_vip') {
    await bot.editMessageText(
      `💎 *PAKET PREMIUM*\n\n🎁 Free Trial: 12 jam pertama\n\n💳 *Beli Paket (QRIS Otomatis):*\n• 5 Hari — Rp 2.000\n• 30 Hari — Rp 10.000\n• Permanen — Rp 50.000\n\n💰 *Tukar Koin:*\n• 5 Koin → 2 Hari\n• 10 Koin → 5 Hari\n• 50 Koin → 40 Hari`,
      { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'🛒 5 Hari — Rp 2.000',    callback_data:'buy:p5'    }],
        [{ text:'🛒 30 Hari — Rp 10.000',  callback_data:'buy:p30'   }],
        [{ text:'🛒 Permanen — Rp 50.000', callback_data:'buy:pPerm' }],
        [{ text:'💰 Tukar Koin', callback_data:'exc_menu' }],
        [{ text:T(uid,'btn_back'), callback_data:'back_main' }]
      ]}}
    );
    return;
  }

  // BELI PAKET - buat QRIS
  if (data.startsWith('buy:')) {
    const planId = data.slice(4);
    const plan = PLANS[planId];
    if (!plan) return;
    await bot.answerCallbackQuery(query.id, { text: '⏳ Membuat QRIS...' });
    try {
      await bot.editMessageText(
        '⏳ *Membuat QRIS...*\nMohon tunggu sebentar.',
        { chat_id:chatId, message_id:msgId, parse_mode:'Markdown' }
      );

      // Buat invoice
      const inv = await pay.createInvoice(db, uid, planId, PLANS);

      // Generate QR image
      const qrFile = await pay.generateQrisImage(inv.qrString, TEMP_FOLDER);

      const expMin = Math.ceil(pay.QR_TTL / 60000);
      const qrBuf = fs.readFileSync(qrFile); pay.safeUnlink(qrFile);
      await bot.sendPhoto(chatId, qrBuf, {
        caption:
          `💳 *PEMBAYARAN QRIS*\n\n` +
          `📦 Paket: *${plan.nama}*\n` +
          `💰 Harga: *Rp ${plan.harga.toLocaleString('id-ID')}*\n\n` +
          `⏳ QR berlaku *${expMin} menit*\n` +
          `_Scan dengan m-banking / e-wallet apapun_`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '🔄 Cek Status Bayar', callback_data: `cekbayar:${inv.reffId}` }
        ]]}
      });
      pay.safeUnlink(qrFile);

      // Auto-poll setiap 5 detik
      if (invoicePollers[uid]) clearInterval(invoicePollers[uid]);
      invoicePollers[uid] = setInterval(async () => {
        try {
          const res = await pay.checkStatus(inv.reffId);
          if (pay.isPaid(res)) {
            clearInterval(invoicePollers[uid]); delete invoicePollers[uid];
            inv.status = 'paid';
            const nv = db.addVipDays(uid, plan.hari);
            const vipText = plan.hari >= 36500 ? 'Permanen ♾️' : `Hingga ${nv.toLocaleDateString('id-ID')}`;
            await bot.sendMessage(chatId,
              `✅ *Pembayaran Diterima!*\n\n🎉 Paket *${plan.nama}* aktif!\n📅 VIP: ${vipText}`,
              { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{ text:'🏠 Menu Utama', callback_data:'back_main' }]]} }
            );
          }
          if (pay.isExpired(res)) {
            clearInterval(invoicePollers[uid]); delete invoicePollers[uid];
            await bot.sendMessage(chatId, '❌ QRIS expired.\nSilakan beli ulang.', {
              reply_markup:{ inline_keyboard:[[{ text:'💎 Beli Lagi', callback_data:'f_vip' }]]}
            });
          }
        } catch(e) {}
      }, 5000);
      // Stop poll setelah 5 menit
      setTimeout(() => { if(invoicePollers[uid]){ clearInterval(invoicePollers[uid]); delete invoicePollers[uid]; } }, 5 * 60_000);

    } catch(e) {
      let errMsg = e.message || 'Unknown error';
      let extraMsg = '';
      if (errMsg.includes('CF_BLOCKED') || errMsg.includes('Cloudflare')) {
        extraMsg = '\n\n⚠️ *Solusi:* Tambahkan Fixie di Railway:\n1. Railway → project → + New → Fixie\n2. Copy IP dari Fixie Dashboard\n3. atlantich2h.com → API → IP Whitelist → tambah IP';
        errMsg = 'Server payment sedang tidak bisa diakses.';
      } else if (errMsg.includes('ATLANTIC_API_KEY')) {
        errMsg = 'API Key Atlantic belum diset di server.';
      } else if (errMsg.includes('qrcode')) {
        errMsg = 'Package qrcode belum terinstall.';
      } else if (errMsg.includes('Timeout')) {
        errMsg = 'Koneksi ke server payment timeout. Coba lagi.';
      }
      await bot.sendMessage(chatId,
        `❌ *Gagal buat QRIS*\n\n${errMsg}${extraMsg}\n\n📞 Hubungi: ${CEO_USERNAME}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // CEK STATUS BAYAR MANUAL
  if (data.startsWith('cekbayar:')) {
    const reffId = data.slice(9);
    await bot.answerCallbackQuery(query.id, { text: '🔍 Mengecek...' });
    try {
      const res = await pay.checkStatus(reffId);
      if (pay.isPaid(res)) {
        await bot.answerCallbackQuery(query.id, { text: '✅ Sudah dibayar!', show_alert: true });
      } else if (pay.isExpired(res)) {
        await bot.answerCallbackQuery(query.id, { text: '❌ QRIS sudah expired', show_alert: true });
      } else {
        await bot.answerCallbackQuery(query.id, { text: '⏳ Belum dibayar, tunggu sebentar...', show_alert: false });
      }
    } catch(e) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Gagal cek status', show_alert: true });
    }
    return;
  }
  if (data==='exc_menu') {
    const u=db.getUser(uid);
    await bot.editMessageText(
      `💰 *TUKAR KOIN*\n\nKoin kamu: ${u?u.coins:0}\n\nPilih paket:`,
      { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'5 Koin → 2 Hari',   callback_data:'exc_2day'  }],
        [{ text:'10 Koin → 5 Hari',  callback_data:'exc_5day'  }],
        [{ text:'50 Koin → 40 Hari', callback_data:'exc_40day' }],
        [{ text:T(uid,'btn_back'), callback_data:'back_main' }]
      ]}}
    );
    return;
  }
  if (data.startsWith('exc_') && data!=='exc_menu') {
    const pkg=COIN_PACKAGES[data.slice(4)]; if(!pkg) return;
    const u=db.getUser(uid);
    if (!u||u.coins<pkg.coins) { await bot.editMessageText(`❌ Koin tidak cukup\nKamu: ${u?u.coins:0} | Perlu: ${pkg.coins}`,{chat_id:chatId,message_id:msgId}); return; }
    db.useCoins(uid,pkg.coins);
    const nv=db.addVipDays(uid,pkg.days);
    await bot.editMessageText(`✅ Berhasil!\n\nVIP hingga ${nv.toLocaleDateString('id-ID')}`,{chat_id:chatId,message_id:msgId});
    return;
  }

  // REFERRAL
  if (data==='f_referral') {
    const me=await bot.getMe(), link=`https://t.me/${me.username}?start=ref${uid}`, u=db.getUser(uid);
    await bot.editMessageText(
      `👥 *REFERRAL*\n\n🎁 1 referral = 1 koin\n\nReferral: ${db.getRefs(uid)}\nKoin: ${u?u.coins:0}\n\n🔗 Link:\n\`${link}\``,
      { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:backKb(uid) }
    );
    return;
  }

  // ADMIN PANEL
  if (data==='f_admin') {
    if (!isAdmin(uid)) return;
    const s=db.getStats();
    await bot.editMessageText(
      `🔐 *PANEL ADMIN*\n\n👥 Total: ${s.total}\n💎 VIP: ${s.vip}\n🆓 Free: ${s.total-s.vip}\n🔗 Referral: ${s.refs}`,
      { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{ text:'📋 Daftar User',   callback_data:'adm_list'      }],
        [{ text:'➕ Tambah VIP',    callback_data:'adm_addvip'    }],
        [{ text:'🚫 Stop User',     callback_data:'adm_stop'      }],
        [{ text:'📢 Broadcast',     callback_data:'adm_broadcast' }],
        [{ text:T(uid,'btn_back'), callback_data:'back_main'      }]
      ]}}
    );
    return;
  }
  if (data==='adm_list') {
    if (!isAdmin(uid)) return;
    const users = db.getAllUsers();
    // Buat konten file TXT
    let lines = `DAFTAR USER BOT\nTotal: ${users.length} user\nDigenerate: ${new Date().toLocaleString('id-ID')}\n`;
    lines += '='.repeat(40) + '\n\n';
    users.forEach((u, i) => {
      const vipStatus = u.vip_until && new Date(u.vip_until) > new Date()
        ? `VIP hingga ${new Date(u.vip_until).toLocaleDateString('id-ID')}`
        : 'Free';
      const username = u.username ? '@' + u.username : '-';
      const status = u.is_active ? 'Aktif' : 'Stop';
      lines += `${i+1}.\n`;
      lines += `   ID       : ${u.user_id}\n`;
      lines += `   USERNAME : ${username}\n`;
      lines += `   NAMA     : ${u.first_name || '-'}\n`;
      lines += `   STATUS   : ${status}\n`;
      lines += `   VIP      : ${vipStatus}\n`;
      lines += `   KOIN     : ${u.coins || 0}\n`;
      lines += `   DAFTAR   : ${new Date(u.registered_at).toLocaleDateString('id-ID')}\n`;
      lines += '\n';
    });

    const tmpPath = `${TEMP_FOLDER}/userlist_${uid}.txt`;
    fs.writeFileSync(tmpPath, lines, 'utf8');
    await bot.answerCallbackQuery(query.id);
    await sendFileNamed(chatId, tmpPath, `daftar_user_${users.length}.txt`,
      `👥 *Daftar User*\nTotal: *${users.length}* user\nFile berisi detail semua user.`
    );
    return;
  }
  if (data==='adm_addvip') {
    if (!isAdmin(uid)) return;
    clear(uid); setState(uid,S.ADM_ADDID);
    await bot.editMessageText('👤 Kirim *ID user* yang akan ditambah VIP:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }
  if (data==='adm_stop') {
    if (!isAdmin(uid)) return;
    clear(uid); setState(uid,S.ADM_STOPID);
    await bot.editMessageText('🚫 Kirim *ID user* yang akan di-stop:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }
  if (data==='adm_broadcast') {
    if (!isAdmin(uid)) return;
    clear(uid); setState(uid,S.ADM_MSG);
    await bot.editMessageText('📢 Ketik *pesan broadcast*:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }

  // ==================== FEATURES ====================

  if (data==='f_manual') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'numbers',[]); setState(uid,S.MAN_NUMS);
    await bot.editMessageText('✏️ *Input Manual*\n\nKirim nomor telepon (satu per baris atau pisah koma).\nKlik *Selesai* jika sudah.',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:doneKb(uid,'manual_done')});
    return;
  }
  if (data==='f_add') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'numbers',[]); setState(uid,S.ADD_NUMS);
    await bot.editMessageText('➕ *Tambah Kontak*\n\nKirim nomor telepon (satu per baris atau pisah koma).\nKlik *Selesai* jika sudah.',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:doneKb(uid,'add_done')});
    return;
  }
  if (data==='f_delete') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setState(uid,S.DEL_FILE);
    await bot.editMessageText('🗑️ *Hapus Kontak*\n\nKirim file *.vcf* yang ingin diedit:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }
  if (data==='f_renamectc') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'rnc_files',[]); setState(uid,S.RNC_FILE);
    await bot.editMessageText(
      '📝 *Ganti Nama Kontak*\n\n📂 Kirim semua file *.vcf* yang ingin diganti nama kontaknya.\n_(Bot otomatis proses setelah semua file diterima)_',
      {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:cancelKb(uid)}
    );
    setD(uid,'rnc_status_id', msgId);
    return;
  }
  if (data==='f_renamefile') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'rnf_files',[]); setState(uid,S.RNF_FILE);
    await bot.editMessageText(
      '🏷️ *Ganti Nama File*\n\n📂 Kirim semua file yang ingin direname.\n_(Setelah semua file terkirim, bot otomatis minta nama baru)_',
      {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:cancelKb(uid)}
    );
    setD(uid,'rnf_status_id', msgId);
    return;
  }
  if (data==='f_merge') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'merge_files',[]); setState(uid,S.MERGE);
    await bot.editMessageText(
      '🔗 *Gabung File*\n\n📂 Kirim semua file *.vcf* atau *.txt* yang ingin digabung jadi 1 file.\n_(Bot otomatis proses setelah semua file diterima)_',
      {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:cancelKb(uid)}
    );
    setD(uid,'merge_status_id', msgId);
    return;
  }
  if (data==='f_split') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setState(uid,S.SPL_FILE);
    await bot.editMessageText('✂️ *Pecah File TXT*\n\nKirim file *.txt*:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }
  if (data==='f_nodup') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'nodup_files',[]); setState(uid,S.NODUP);
    await bot.editMessageText(
      '🧹 *Hapus Duplikat*\n\n📂 Kirim semua file *.vcf* yang ingin dihapus duplikatnya.\n_(Bot otomatis proses setelah semua file diterima)_',
      {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:cancelKb(uid)}
    );
    setD(uid,'nodup_status_id', msgId);
    return;
  }
  if (data==='f_count') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setState(uid,S.COUNT);
    await bot.editMessageText('🔢 *Hitung Kontak*\n\nKirim file *.vcf* atau *.txt*:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }
  if (data==='f_getconten') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setState(uid,S.GETCONTEN);
    await bot.editMessageText('📖 *Lihat Isi File TXT*\n\nKirim file *.txt*:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    return;
  }
  if (data==='f_tovcf') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'tovcf_files',[]); setState(uid,S.TOVCF_FILE);
    await bot.editMessageText(
      '🔄 *TXT → VCF*\n\n📂 Kirim semua file *.txt* berisi nomor telepon.\n_(Bot otomatis proses setelah semua file diterima)_',
      {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:cancelKb(uid)}
    );
    setD(uid,'tovcf_status_id', msgId);
    return;
  }
  if (data==='f_totxt') {
    if (!vipOk(chatId,uid)) return;
    clear(uid); setD(uid,'vcf_files',[]); setState(uid,S.TOTXT);
    await bot.editMessageText(
      '🔄 *VCF → TXT*\n\n📂 Kirim semua file *.vcf* kamu.\n_(Setelah semua file terkirim, bot otomatis minta nama file)_',
      {chat_id:chatId, message_id:msgId, parse_mode:'Markdown', reply_markup:cancelKb(uid)}
    );
    setD(uid,'status_msg_id', msgId);
    return;
  }

  // ==================== DONE BUTTONS ====================

  if (data==='manual_done'||data==='add_done') {
    const nums=getD(uid,'numbers')||[];
    if (!nums.length) { await bot.answerCallbackQuery(query.id,{text:'⚠️ Belum ada nomor!',show_alert:true}); return; }
    const isMan=data==='manual_done';
    await bot.editMessageText(`📊 Total: ${nums.length} nomor\n\nPilih format output:`,{chat_id:chatId,message_id:msgId,reply_markup:{inline_keyboard:[
      [{ text:'📄 TXT', callback_data:isMan?'mfmt_txt':'afmt_txt' },{ text:'📇 VCF', callback_data:isMan?'mfmt_vcf':'afmt_vcf' }],
      [{ text:T(uid,'btn_cancel'), callback_data:'back_main' }]
    ]}});
    return;
  }

  if (/^[ma]fmt_(txt|vcf)$/.test(data)) {
    const fmt=data.split('_')[1], isMan=data.startsWith('m');
    setD(uid,'format',fmt);
    if (fmt==='txt') {
      setState(uid,isMan?S.MAN_FNAME:S.ADD_FNAME);
      await bot.editMessageText('📄 Ketik *nama file* (tanpa ekstensi):',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    } else {
      setState(uid,isMan?S.MAN_NAME:S.ADD_NAME);
      await bot.editMessageText('📝 Ketik *nama kontak*:',{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:cancelKb(uid)});
    }
    return;
  }






});

// ============= MESSAGE HANDLER =============
bot.on('message', async (msg) => {
  if (!msg.from || (msg.text&&msg.text.startsWith('/'))) return;
  // Hanya respon di private chat
  if (msg.chat.type !== 'private') return;
  const chatId=msg.chat.id, uid=msg.from.id, state=getState(uid);
  const txt=msg.text?.trim()||'', doc=msg.document;
  if (!state) return;

  async function goMain() { clear(uid); await sendMain(chatId,uid,msg.from.first_name); }

  // BROADCAST
  if (state===S.ADM_MSG) {
    if (!isAdmin(uid)){ clear(uid); return; }
    const users=db.getActive(); await bot.sendMessage(chatId,`⏳ Mengirim ke ${users.length} user...`);
    let ok=0; for(const u of users){ try{ await bot.sendMessage(u,txt); ok++; }catch(e){} }
    await bot.sendMessage(chatId,`✅ Terkirim: ${ok}/${users.length}`);
    await goMain(); return;
  }

  // ADMIN ADD VIP
  if (state===S.ADM_ADDID) {
    const id=parseInt(txt); if(isNaN(id)){ await bot.sendMessage(chatId,'❌ ID harus angka'); return; }
    setD(uid,'target_id',id); setState(uid,S.ADM_ADDDAYS);
    await bot.sendMessage(chatId,'🗓️ Berapa hari VIP?'); return;
  }
  if (state===S.ADM_ADDDAYS) {
    const days=parseInt(txt); if(isNaN(days)||days<=0){ await bot.sendMessage(chatId,'❌ Harus angka > 0'); return; }
    const nv=db.addVipDays(getD(uid,'target_id'),days);
    await bot.sendMessage(chatId,`✅ VIP hingga ${nv.toLocaleDateString('id-ID')}`);
    await goMain(); return;
  }

  // ADMIN STOP
  if (state===S.ADM_STOPID) {
    const id=parseInt(txt); if(isNaN(id)){ await bot.sendMessage(chatId,'❌ ID harus angka'); return; }
    db.deactivate(id); await bot.sendMessage(chatId,`✅ User ${id} di-stop`);
    await goMain(); return;
  }

  // COLLECT NUMBERS
  if (state===S.MAN_NUMS||state===S.ADD_NUMS) {
    if (!txt) return;
    let nums; if(txt.includes('\n')) nums=txt.split('\n').map(n=>n.trim()).filter(Boolean);
    else if(txt.includes(',')) nums=txt.split(',').map(n=>n.trim()).filter(Boolean);
    else nums=[txt];
    const ex=getD(uid,'numbers')||[]; setD(uid,'numbers',ex.concat(nums));
    await bot.sendMessage(chatId,`✅ ${nums.length} nomor diterima\nTotal: ${ex.length+nums.length} nomor`); return;
  }

  // CONTACT NAME
  if (state===S.MAN_NAME||state===S.ADD_NAME) {
    setD(uid,'contact_name',txt);
    setState(uid,state===S.MAN_NAME?S.MAN_FNAME:S.ADD_FNAME);
    await bot.sendMessage(chatId,'📄 Ketik *nama file* (tanpa ekstensi):',{parse_mode:'Markdown'}); return;
  }

  // FILE NAME → CREATE
  if (state===S.MAN_FNAME||state===S.ADD_FNAME) {
    await buildAndSend(chatId,uid,txt,msg.from.first_name); return;
  }

  // DELETE
  if (state===S.DEL_FILE) {
    if (!doc||!doc.file_name.endsWith('.vcf')){ await bot.sendMessage(chatId,'❌ Harus file .vcf'); return; }
    const fp=`${TEMP_FOLDER}/del_${uid}.vcf`; await dlFile(doc.file_id,fp);
    setD(uid,'vcf_file',fp); setD(uid,'orig',doc.file_name); setState(uid,S.DEL_PAT);
    await bot.sendMessage(chatId,'🔍 Ketik *nama atau nomor* yang akan dihapus:',{parse_mode:'Markdown'}); return;
  }
  if (state===S.DEL_PAT) {
    const fp=getD(uid,'vcf_file'), orig=getD(uid,'orig');
    try {
      const all=getVcards(fs.readFileSync(fp,'utf8')); let del=0;
      const filtered=all.filter(v=>{ if(v.toLowerCase().includes(txt.toLowerCase())){del++;return false;} return true; });
      if (!del){ await bot.sendMessage(chatId,'❌ Tidak ada kontak yang cocok'); rmFile(fp); await goMain(); return; }
      fs.writeFileSync(fp,filtered.join('\n'));
      await sendFileNamed(chatId,fp,orig,`✅ ${del} kontak dihapus!`);
    } catch(e){ rmFile(fp); await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    await goMain(); return;
  }

  // RENAME CONTACT
  // GANTI NAMA KONTAK - kumpulkan file dulu
  if (state===S.RNC_FILE) {
    if (!doc||!doc.file_name.endsWith('.vcf')){ await bot.sendMessage(chatId,'❌ Harus file .vcf'); return; }
    const statusId=getD(uid,'rnc_status_id');
    collectFiles(chatId, uid, doc.file_id, '.vcf', doc.file_name, 'rnc_files', statusId,
      '📝 *Ganti Nama Kontak*',
      async (cid, u, allFiles) => {
        if (getState(u) !== S.RNC_FILE) return;
        const paths = allFiles.map(f => f.path);
        setD(u, 'rnc_files', paths);
        setState(u, S.RNC_NEW);
        await bot.sendMessage(cid,
          `✅ *${allFiles.length} file VCF* siap diproses!\n\n✏️ Ketik *nama baru* untuk semua kontak:`,
          {parse_mode:'Markdown'});
      }
    );
    return;
  }
  // PROSES ganti nama - semua kontak di semua file diganti ke nama baru
  if (state===S.RNC_NEW) {
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama baru'); return; }
    const newName=txt.trim();
    const files=getD(uid,'rnc_files')||[];
    await bot.sendMessage(chatId,'⏳ Memproses...');
    try {
      const toSend=[];
      let totalReplaced=0;
      for(let i=0;i<files.length;i++){
        const fp=files[i];
        let c=fs.readFileSync(fp,'utf8');
        // Ganti semua FN: dengan nama baru + nomor urut
        const vcards=getVcards(c);
        let idx=1;
        c=c.replace(/^FN:.+$/gm, ()=>`FN:${newName} ${String(idx++).padStart(3,'0')}`);
        totalReplaced+=idx-1;
        const outName=files.length===1?`${newName}.vcf`:`${newName}${String(i+1).padStart(2,'0')}.vcf`;
        const tmp=`${TEMP_FOLDER}/tmp_${uid}_rnc${i}.vcf`;
        fs.writeFileSync(tmp,c);
        toSend.push({path:tmp, name:outName});
        rmFile(fp);
      }
      await bot.sendMessage(chatId,`✅ *${totalReplaced} kontak* berhasil diganti ke *${newName}*`,{parse_mode:'Markdown'});
      await sendFiles(chatId,toSend);
    } catch(e){
      for(const fp of files) rmFile(fp);
      await bot.sendMessage(chatId,`❌ Error: ${e.message}`);
    }
    await goMain(); return;
  }

  // RENAME FILE
  if (state===S.RNF_FILE) {
    if (!doc){ await bot.sendMessage(chatId,'❌ Kirim file terlebih dahulu'); return; }
    const ext=path.extname(doc.file_name);
    const statusId=getD(uid,'rnf_status_id');
    collectFiles(chatId, uid, doc.file_id, ext, doc.file_name, 'rnf_files', statusId,
      '🏷️ *Ganti Nama File*',
      async (cid, u, allFiles) => {
        if (getState(u) !== S.RNF_FILE) return;
        setState(u, S.RNF_NAME);
        await bot.sendMessage(cid,
          `✅ *${allFiles.length} file* siap direname!\n\n✏️ Ketik *nama baru* (tanpa ekstensi):`,
          {parse_mode:'Markdown'});
      }
    );
    return;
  }
  if (state===S.RNF_NAME) {
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama file'); return; }
    const baseName=txt.replace(/\.[^/.]+$/,''); // hapus ekstensi jika ada
    const files=getD(uid,'rnf_files')||[];
    await bot.sendMessage(chatId,'⏳ Memproses...');
    try {
      const toSend=[];
      for(let i=0;i<files.length;i++){
        const f=files[i];
        const newName = files.length===1
          ? `${baseName}${f.ext}`
          : `${baseName}${String(i+1).padStart(2,'0')}${f.ext}`;
        toSend.push({path:f.path, name:newName});
      }
      await sendFiles(chatId,toSend);
    } catch(e){
      for(const f of files) rmFile(f.path);
      await bot.sendMessage(chatId,`❌ Error: ${e.message}`);
    }
    await goMain(); return;
  }

  // MERGE (receive files - support TXT dan VCF)
  if (state===S.MERGE) {
    if (!doc){ await bot.sendMessage(chatId,'❌ Kirim file terlebih dahulu'); return; }
    const ext=path.extname(doc.file_name).toLowerCase();
    if (ext!=='.vcf'&&ext!=='.txt'){ await bot.sendMessage(chatId,'❌ Harus file .vcf atau .txt'); return; }
    const statusId=getD(uid,'merge_status_id');
    collectFiles(chatId, uid, doc.file_id, ext, doc.file_name, 'merge_files', statusId,
      '🔗 *Gabung File*',
      async (cid, u, allFiles) => {
        if (getState(u) !== S.MERGE) return;
        if (allFiles.length < 2) { await bot.sendMessage(cid,'❌ Minimal 2 file untuk digabung'); return; }
        setD(u, 'merge_files', allFiles);
        setState(u, S.MERGE_FNAME);
        await bot.sendMessage(cid, `✅ *${allFiles.length} file* siap digabung!\n\n📄 Ketik *nama file hasil* (tanpa ekstensi):`, {parse_mode:'Markdown'});
      }
    );
    return;
  }

  // NODUP (receive files)
  if (state===S.NODUP) {
    if (!doc||!doc.file_name.endsWith('.vcf')){ await bot.sendMessage(chatId,'❌ Harus file .vcf'); return; }
    const statusId=getD(uid,'nodup_status_id');
    collectFiles(chatId, uid, doc.file_id, '.vcf', doc.file_name, 'nodup_files', statusId,
      '🧹 *Hapus Duplikat*',
      async (cid, u, allFiles) => {
        if (getState(u) !== S.NODUP) return;
        const paths = allFiles.map(f => f.path);
        setD(u, 'nodup_files', paths);
        setState(u, S.NODUP_FNAME);
        await bot.sendMessage(cid, `✅ *${allFiles.length} file VCF* siap diproses!\n\n📄 Ketik *nama file hasil* (tanpa ekstensi):`, {parse_mode:'Markdown'});
      }
    );
    return;
  }

  // TOTXT (receive files)
  if (state===S.TOTXT) {
    if (!doc||!doc.file_name.endsWith('.vcf')){ await bot.sendMessage(chatId,'❌ Harus file .vcf'); return; }
    const statusMsgId=getD(uid,'status_msg_id');
    collectFiles(chatId, uid, doc.file_id, '.vcf', doc.file_name, 'vcf_files', statusMsgId,
      '🔄 *VCF → TXT*',
      async (cid, u, allFiles) => {
        if (getState(u) !== S.TOTXT) return;
        // Fix: vcf_files simpan sebagai array of path string (bukan object)
        const paths = allFiles.map(f => f.path);
        setD(u, 'vcf_files', paths);
        setState(u, S.TOTXT_FNAME);
        await bot.sendMessage(cid,
          `✅ *${allFiles.length} file VCF* siap dikonversi!\n\n📄 Ketik *nama file* hasil TXT (tanpa ekstensi):`,
          {parse_mode:'Markdown'});
      }
    );
    return;
  }

  // COUNT
  if (state===S.COUNT) {
    if (!doc){ await bot.sendMessage(chatId,'❌ Kirim file .vcf atau .txt'); return; }
    const fp=`${TEMP_FOLDER}/cnt_${uid}.tmp`; await dlFile(doc.file_id,fp);
    try {
      const c=fs.readFileSync(fp,'utf8');
      const m=doc.file_name.endsWith('.vcf')?T(uid,'total_contacts',{count:getVcards(c).length}):T(uid,'total_lines',{count:c.split('\n').filter(l=>l.trim()).length});
      await bot.sendMessage(chatId,m); rmFile(fp);
    } catch(e){ rmFile(fp); await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    await goMain(); return;
  }

  // GETCONTEN (txt)
  if (state===S.GETCONTEN) {
    if (!doc||!doc.file_name.endsWith('.txt')){ await bot.sendMessage(chatId,'❌ Harus file .txt'); return; }
    const fp=`${TEMP_FOLDER}/gct_${uid}.txt`; await dlFile(doc.file_id,fp);
    try {
      const c=fs.readFileSync(fp,'utf8'), lines=c.split('\n').filter(l=>l.trim()), prev=c.length>3000?c.slice(0,3000)+'...':c;
      await bot.sendMessage(chatId,'📄 *ISI FILE*\n\n```\n'+prev+'\n```\n\n📊 Total baris: '+lines.length,{parse_mode:'Markdown'}); rmFile(fp);
    } catch(e){ rmFile(fp); await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    await goMain(); return;
  }

  // GETCONTENT (vcf preview)
  if (state===S.GETCONTENT) {
    if (!doc||!doc.file_name.endsWith('.vcf')){ await bot.sendMessage(chatId,'❌ Harus file .vcf'); return; }
    const fp=`${TEMP_FOLDER}/gc_${uid}.vcf`; await dlFile(doc.file_id,fp);
    try {
      const c=fs.readFileSync(fp,'utf8'), v=getVcards(c), prev=c.length>3000?c.slice(0,3000)+'...':c;
      await bot.sendMessage(chatId,'📄 *ISI FILE VCF*\n\n```\n'+prev+'\n```\n\n📊 Total kontak: '+v.length,{parse_mode:'Markdown'}); rmFile(fp);
    } catch(e){ rmFile(fp); await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    await goMain(); return;
  }

  // TO_VCF
  // TOVCF - kumpulkan banyak file TXT
  if (state===S.TOVCF_FILE) {
    if (!doc||!doc.file_name.endsWith('.txt')){ await bot.sendMessage(chatId,'❌ Harus file .txt'); return; }
    const statusId=getD(uid,'tovcf_status_id');
    collectFiles(chatId, uid, doc.file_id, '.txt', doc.file_name, 'tovcf_files', statusId,
      '🔄 *TXT → VCF*',
      async (cid, u, allFiles) => {
        if (getState(u) !== S.TOVCF_FILE) return;
        setD(u,'tovcf_paths', allFiles.map(f=>f.path));
        setState(u, S.TOVCF_CNAME);
        await bot.sendMessage(cid,
          `✅ *${allFiles.length} file* diterima!\n\n📝 Ketik *nama kontak*:`,
          {parse_mode:'Markdown'});
      }
    );
    return;
  }
  // TOVCF - nama kontak
  if (state===S.TOVCF_CNAME) {
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama kontak'); return; }
    setD(uid,'cname',txt); setState(uid,S.TOVCF_FNAME);
    await bot.sendMessage(chatId,'📄 Ketik *nama file* (tanpa ekstensi):',{parse_mode:'Markdown'}); return;
  }
  if (state===S.TOVCF_FNAME){
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama file'); return; }
    setD(uid,'fname',txt.endsWith('.vcf')?txt.slice(0,-4):txt); setState(uid,S.TOVCF_LIM);
    await bot.sendMessage(chatId,'🔢 Berapa nomor per file?\n_(Ketik angka, atau *all* untuk 1 file besar)_',{parse_mode:'Markdown'}); return;
  }
  if (state===S.TOVCF_LIM) {
    const inp=txt.toLowerCase(), paths=getD(uid,'tovcf_paths')||[], cname=getD(uid,'cname'), fname=getD(uid,'fname');
    // Gabung semua nomor dari semua file
    let allNums=[];
    for(const fp of paths){
      try { allNums=allNums.concat(fs.readFileSync(fp,'utf8').split('\n').map(l=>l.trim()).filter(Boolean)); } catch(e){}
    }
    allNums=[...new Set(allNums)]; // hapus duplikat
    if (!allNums.length){ for(const fp of paths) rmFile(fp); await bot.sendMessage(chatId,'❌ Tidak ada nomor ditemukan!'); await goMain(); return; }
    const limit=inp==='all'?allNums.length:(parseInt(inp)||allNums.length);
    await bot.sendMessage(chatId,'⏳ Memproses...');
    try {
      const total=Math.ceil(allNums.length/limit);
      if (total===1) {
        const tmp=`${TEMP_FOLDER}/tmp_${uid}_tv.vcf`;
        fs.writeFileSync(tmp,allNums.map((n,i)=>mkVcard(cname,n,i+1)).join(''));
        await sendFileNamed(chatId,tmp,`${fname}.vcf`,`✅ Selesai! Total: ${allNums.length} kontak`);
      } else {
        const toSend=[];
        for(let fi=0;fi<total;fi++){
          const chunk=allNums.slice(fi*limit,(fi+1)*limit);
          const tmp=`${TEMP_FOLDER}/tmp_${uid}_tv${fi}.vcf`;
          fs.writeFileSync(tmp,chunk.map((n,i)=>mkVcard(cname,n,fi*limit+i+1)).join(''));
          toSend.push({path:tmp, name:`${fname}${String(fi+1).padStart(2,'0')}.vcf`});
        }
        await sendFiles(chatId,toSend);
      }
    } catch(e){ await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    for(const fp of paths) rmFile(fp);
    await goMain(); return;
  }

  // SPLIT
  if (state===S.SPL_FILE) {
    if (!doc||!doc.file_name.endsWith('.txt')){ await bot.sendMessage(chatId,'❌ Harus file .txt'); return; }
    const fp=`${TEMP_FOLDER}/spl_${uid}.txt`; await dlFile(doc.file_id,fp);
    setD(uid,'spl_file',fp); setD(uid,'spl_name',doc.file_name.replace('.txt','')); setState(uid,S.SPL_CNT);
    await bot.sendMessage(chatId,'🔢 Mau dibagi jadi *berapa bagian*?',{parse_mode:'Markdown'}); return;
  }
  if (state===S.SPL_CNT) {
    const parts=parseInt(txt); if(isNaN(parts)||parts<=0){ await bot.sendMessage(chatId,'❌ Harus angka > 0'); return; }
    const fp=getD(uid,'spl_file'), orig=getD(uid,'spl_name')||'split';
    await bot.sendMessage(chatId,'⏳ Memproses...');
    const lines=fs.readFileSync(fp,'utf8').split('\n').map(l=>l.trim()).filter(Boolean);
    const size=Math.ceil(lines.length/parts), toSend=[];
    for(let i=0;i<parts;i++){
      const chunk=lines.slice(i*size,(i+1)*size); if(!chunk.length) continue;
      const tmp=`${TEMP_FOLDER}/tmp_${uid}_spl${i+1}.txt`; fs.writeFileSync(tmp,chunk.join('\n'));
      toSend.push({path:tmp, name:`${orig}${String(i+1).padStart(2,'0')}.txt`});
    }
    await sendFiles(chatId,toSend); for(const f of toSend) rmFile(f.path); rmFile(fp);
    await goMain(); return;
  }

  // MERGE_FNAME - gabung semua jadi 1 file (support TXT dan VCF)
  if (state===S.MERGE_FNAME) {
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama file'); return; }
    const rawFiles=getD(uid,'merge_files')||[];
    await bot.sendMessage(chatId,'⏳ Menggabungkan...');
    try {
      // Deteksi tipe mayoritas file
      const files = Array.isArray(rawFiles[0]) ? rawFiles : rawFiles;
      const firstExt = (files[0]?.ext||files[0]?.origName||'.vcf').includes('.txt') ? '.txt' : '.vcf';
      const fname = txt.replace(/\.[^/.]+$/, ''); // hapus ekstensi jika ada
      const outName = fname + firstExt;
      let merged='', totalItems=0;
      for(const f of files){
        const fp = typeof f==='string' ? f : f.path;
        const ext = typeof f==='string' ? (fp.endsWith('.txt')?'.txt':'.vcf') : (f.ext||'.vcf');
        try {
          const c=fs.readFileSync(fp,'utf8');
          if (ext==='.vcf') {
            const vcards=getVcards(c);
            merged+=vcards.join('')+'\n'; totalItems+=vcards.length;
          } else {
            const lines=c.split('\n').map(l=>l.trim()).filter(Boolean);
            merged+=lines.join('\n')+'\n'; totalItems+=lines.length;
          }
        } catch(e){}
      }
      const out=`${TEMP_FOLDER}/tmp_${uid}_merge${firstExt}`;
      fs.writeFileSync(out,merged);
      const itemLabel = firstExt==='.vcf' ? 'kontak' : 'nomor';
      await sendFileNamed(chatId,out,outName,`✅ *${files.length} file* digabung!\nTotal: *${totalItems} ${itemLabel}*`);
      for(const f of files){ const fp=typeof f==='string'?f:f.path; rmFile(fp); }
      rmFile(out);
    } catch(e){ await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    await goMain(); return;
  }

  // NODUP_FNAME
  if (state===S.NODUP_FNAME) {
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama file'); return; }
    const fname=txt.endsWith('.vcf')?txt.slice(0,-4):txt;
    const files=getD(uid,'nodup_files')||[];
    await bot.sendMessage(chatId,'⏳ Menghapus duplikat...');
    try {
      let all=[];
      for(const fp of files) all=all.concat(getVcards(fs.readFileSync(fp,'utf8')));
      const orig=all.length, uniq=dedup(all), out=`${TEMP_FOLDER}/tmp_${uid}_nodup.vcf`;
      fs.writeFileSync(out,uniq.join('\n'));
      await sendFileNamed(chatId,out,`${fname}.vcf`,`✅ Selesai!\n\nAsli: ${orig}\nUnik: ${uniq.length}\nDihapus: ${orig-uniq.length}`);
      for(const fp of files) rmFile(fp); rmFile(out);
    } catch(e){ await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    await goMain(); return;
  }

  // TOTXT_FNAME - tiap VCF jadi 1 TXT terpisah
  if (state===S.TOTXT_FNAME) {
    if (!txt){ await bot.sendMessage(chatId,'❌ Ketik nama file'); return; }
    const fname=txt.endsWith('.txt')?txt.slice(0,-4):txt;
    const files=getD(uid,'vcf_files')||[];
    await bot.sendMessage(chatId,'⏳ Mengkonversi...');
    try {
      const toSend=[];
      for(let i=0;i<files.length;i++){
        const phones=getPhones(fs.readFileSync(files[i],'utf8'));
        if(!phones.length) continue;
        const outName = files.length===1 ? `${fname}.txt` : `${fname}${String(i+1).padStart(2,'0')}.txt`;
        const tmp=`${TEMP_FOLDER}/tmp_${uid}_tt${i}.txt`;
        fs.writeFileSync(tmp,phones.join('\n'));
        toSend.push({path:tmp, name:outName});
      }
      if(!toSend.length){ await bot.sendMessage(chatId,'❌ Tidak ada nomor ditemukan'); }
      else { await sendFiles(chatId,toSend); }
    } catch(e){ await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
    for(const fp of files) rmFile(fp);
    await goMain(); return;
  }

});

// ============= BUILD & SEND FILE =============
async function buildAndSend(chatId, uid, fname, firstName) {
  const nums=getD(uid,'numbers'), fmt=getD(uid,'format'), cname=getD(uid,'contact_name');
  try {
    await bot.sendMessage(chatId,'⏳ Memproses...');
    if (fmt==='txt') {
      const f=fname.endsWith('.txt')?fname.slice(0,-4):fname, fp=`${TEMP_FOLDER}/tmp_${uid}.txt`;
      fs.writeFileSync(fp,nums.join('\n'));
      await sendFileNamed(chatId,fp,`${f}.txt`,`✅ File TXT dibuat!\nTotal: ${nums.length} nomor`);
    } else {
      const f=fname.endsWith('.vcf')?fname.slice(0,-4):fname, fp=`${TEMP_FOLDER}/tmp_${uid}.vcf`;
      fs.writeFileSync(fp,nums.map((n,i)=>mkVcard(cname,n,i+1)).join(''));
      await sendFileNamed(chatId,fp,`${f}.vcf`,`✅ File VCF dibuat!\nTotal: ${nums.length} kontak`);
    }
  } catch(e){ await bot.sendMessage(chatId,`❌ Error: ${e.message}`); }
  clear(uid);
  await sendMain(chatId, uid, firstName);
}

// ============= ERROR HANDLING =============
bot.on('polling_error', err => console.error('Polling error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled:', err?.message));

console.log('🤖 BOT RUNNING — Full Button UI');
