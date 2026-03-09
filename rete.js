// VANS ASSISTANT - WhatsApp Bot v5.6
// .22  = brat stiker PUTIH+HITAM | .anim = bratvid animasi PUTIH+HITAM bergerak
// Anti-ban: rate limit, human delay, browser spoof, auto-reconnect
// Nomor Bot: 2349034143733 | Prefix: . (titik)
"use strict";

const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
  isJidBroadcast, getContentType, downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino          = require("pino");
const { Boom }      = require("@hapi/boom");
const chalk         = require("chalk");
const fs            = require("fs-extra");
const path          = require("path");
const axios         = require("axios");
const FormData      = require("form-data");
const NodeCache     = require("node-cache");
const os            = require("os");
const crypto        = require("crypto");
const { execFile }  = require("child_process");
const { promisify } = require("util");
const execAsync     = promisify(execFile);

const BOT_NUMBER  = "6287752910121";
const PREFIX      = ".";
const SESSION_DIR = path.join(__dirname, "session");
const BOT_JID     = BOT_NUMBER + "@s.whatsapp.net";
const TMP_DIR     = path.join(os.tmpdir(), "vans_bot");

const sleep      = (ms) => new Promise((r) => setTimeout(r, ms));
const logger     = pino({ level: "silent" });
const msgRetry   = new NodeCache({ stdTTL: 600, checkperiod: 120 });
const jadiBotMap = new Map();
// Store pesan masuk — kunci: msgId, nilai: msg object lengkap (termasuk mediaKey)
// Diperlukan agar .sh bisa ambil mediaKey asli dari view once
const msgStore   = new Map();
const MSG_STORE_MAX = 500; // simpan max 500 pesan terakhir

// ── ANTI-BAN: Rate limiter per JID ───────────────────────────
// Mencegah bot merespon terlalu cepat (terlihat seperti manusia)
const rateLimitMap = new Map(); // jid -> { count, resetAt }
const RATE_LIMIT_MAX    = 8;     // max perintah per window
const RATE_LIMIT_WINDOW = 60000; // window 60 detik

function checkRateLimit(jid) {
  const now = Date.now();
  const entry = rateLimitMap.get(jid) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT_WINDOW; }
  entry.count++;
  rateLimitMap.set(jid, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

// ── ANTI-BAN: Human-like random delay ────────────────────────
// Delay acak 0.8-3 detik sebelum balas (mirip manusia mengetik)
function humanDelay() {
  const ms = 800 + Math.floor(Math.random() * 2200);
  return sleep(ms);
}

// ── ANTI-BAN: Browser fingerprint realistis ──────────────────
// Gunakan user-agent WhatsApp Web asli bukan custom
const BROWSER_LIST = [
  ["Windows", "Chrome", "121.0.0"],
  ["macOS",   "Chrome", "120.0.0"],
  ["Ubuntu",  "Chrome", "119.0.0"],
];
const BOT_BROWSER = BROWSER_LIST[Math.floor(Math.random() * BROWSER_LIST.length)];

function printBanner() {
  console.log(chalk.cyan("==========================================="));
  console.log(chalk.cyan("    VANS ASSISTANT BOT  v5.5              "));
  console.log(chalk.cyan("  Nomor : " + BOT_NUMBER));
  console.log(chalk.cyan("  Prefix: .  (titik)                      "));
  console.log(chalk.cyan("==========================================="));
}

const MENU_TEXT = `🤖 *VANS ASSISTANT*
▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰

Halo! Aku siap membantu kamu 😊
Prefix: *.* (titik)

▸ 📌 *GENERAL*
• *.rete* → Tampilkan Menu

▸ 🎨 *STICKER & MEDIA*
• *.22* _[teks]_ → Brat Sticker
• *.anim* _[teks]_ → Brat Video Stiker 🎬
• *.gifstiker* _[url]_ → GIF jadi Stiker Animasi
• *.tt* _[url]_ → Download TikTok
• *.mp3* _[url]_ → Audio TikTok
• *.hd* → Upscale / HD Foto

▸ 🔒 *TOOLS*
• *.sh* → Buka View Once 🔓
• *.jadibot* _[nomor]_ → Clone Bot
• *.stopbot* _[nomor]_ → Matikan Clone Bot

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
_Powered by VANS ASSISTANT_ ⚡`;

async function send(sock, jid, content, quoted) {
  try {
    await sleep(400 + Math.random() * 300);
    return await sock.sendMessage(jid, content, quoted ? { quoted } : {});
  } catch (e) { console.error(chalk.red("[SEND ERROR]"), e.message); }
}

function extractText(msg) {
  if (!msg || !msg.message) return "";
  const t = getContentType(msg.message);
  return (msg.message.conversation || (msg.message[t] && msg.message[t].text) || (msg.message[t] && msg.message[t].caption) || "").trim();
}

async function toWebP(buf) {
  try {
    const sharp = require("sharp");
    return await sharp(buf)
      .resize(512, 512, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .webp({ quality: 90 }).toBuffer();
  } catch (e) { return buf; }
}

function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

function renderBratFrame(text, visChars, bounceY) {
  const displayText = typeof visChars === "number" ? text.slice(0, visChars) : text;
  bounceY = bounceY || 0;
  const { createCanvas } = require("canvas");
  const SIZE = 512;
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.textAlign    = "left";
  ctx.textBaseline = "top";
  let fontSize = 130;
  while (fontSize >= 20) {
    ctx.font = "bold " + fontSize + "px Arial Black, Arial, sans-serif";
    if (wrapText(ctx, text, SIZE - 56).length * fontSize * 1.15 <= SIZE - 56) break;
    fontSize -= 4;
  }
  ctx.font = "bold " + fontSize + "px Arial Black, Arial, sans-serif";
  ctx.fillStyle = "#000000";
  const lines = displayText.trim() ? wrapText(ctx, displayText, SIZE - 56) : [];
  const pad = 28, lineH = fontSize * 1.15;
  lines.forEach((line, i) => ctx.fillText(line, pad, pad + bounceY + i * lineH));
  return canvas.toBuffer("image/png");
}

async function renderBratFrameJimp(text) {
  const Jimp = require("jimp");
  const W = 512, H = 512;
  let img = typeof Jimp.create === "function"
    ? await Jimp.create({ width: W, height: H, color: 0xffffffff })
    : new Jimp(W, H, 0xffffffff);
  const fontKeys = ["FONT_SANS_128_BLACK","FONT_SANS_64_BLACK","FONT_SANS_32_BLACK","FONT_SANS_16_BLACK"];
  let font = null;
  for (const k of fontKeys) { if (!Jimp[k]) continue; try { font = await Jimp.loadFont(Jimp[k]); break; } catch { /* next */ } }
  if (!font) throw new Error("Font Jimp tidak ada");
  const pad = 28;
  img.print(font, pad, pad, { text, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT || 0, alignmentY: Jimp.VERTICAL_ALIGN_TOP || 0 }, W - pad * 2, H - pad * 2);
  const mime = Jimp.MIME_PNG || "image/png";
  return typeof img.getBuffer === "function" ? await img.getBuffer(mime) : await img.getBufferAsync(mime);
}

async function makeBratSticker(text) {
  for (const url of [
    "https://brat.caliphdev.com/api/brat?text=" + encodeURIComponent(text),
    "https://api.xteam.xyz/brat?text=" + encodeURIComponent(text),
    "https://api.siputzx.my.id/api/s/brat?text=" + encodeURIComponent(text),
  ]) {
    try {
      const r = await axios.get(url, { responseType: "arraybuffer", timeout: 10000 });
      if (r.data && r.data.byteLength > 500) { console.log(chalk.green("[BRAT] API OK")); return await toWebP(Buffer.from(r.data)); }
    } catch { /* next */ }
  }
  console.log(chalk.yellow("[BRAT] Generate lokal..."));
  try { return await toWebP(renderBratFrame(text)); }
  catch (e) { return await toWebP(await renderBratFrameJimp(text)); }
}

async function makeAnimTextSticker(text) {
  await execAsync("ffmpeg", ["-version"]).catch(() => { throw new Error("ffmpeg tidak ada. Install: apt-get install -y ffmpeg"); });
  const id = crypto.randomBytes(6).toString("hex");
  const framesDir = path.join(TMP_DIR, "fr_" + id);
  const outWebP   = path.join(TMP_DIR, "an_" + id + ".webp");
  await fs.ensureDir(framesDir);
  try {
    const FRAMES = 36;
    for (let f = 0; f < FRAMES; f++) {
      const t = f / FRAMES;
      let visChars, bounceY = 0;
      if (t <= 0.65) { visChars = Math.max(1, Math.floor((t / 0.65) * text.length)); }
      else { visChars = text.length; bounceY = Math.sin((t - 0.65) / 0.35 * Math.PI * 2) * 6; }
      let frameBuf;
      try { frameBuf = renderBratFrame(text, visChars, bounceY); }
      catch (e) { frameBuf = await renderBratFrameJimp(text.slice(0, visChars) || " "); }
      await fs.writeFile(path.join(framesDir, "f" + String(f).padStart(3, "0") + ".png"), frameBuf);
    }
    await execAsync("ffmpeg", ["-y", "-framerate", "18", "-i", path.join(framesDir, "f%03d.png"), "-vf", "scale=512:512:flags=lanczos", "-loop", "0", "-compression_level", "4", outWebP]);
    const result = await fs.readFile(outWebP);
    console.log(chalk.green("[ANIM] WebP OK, size:", result.length));
    return result;
  } finally { await fs.remove(framesDir).catch(() => {}); await fs.remove(outWebP).catch(() => {}); }
}

async function makeGifSticker(url) {
  const id = crypto.randomBytes(6).toString("hex");
  const gp = path.join(TMP_DIR, "g_" + id + ".gif");
  const op = path.join(TMP_DIR, "gs_" + id + ".webp");
  try {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
    const buf = Buffer.from(res.data);
    if (buf.length < 100) throw new Error("GIF tidak valid");
    await fs.writeFile(gp, buf);
    const ok = await execAsync("ffmpeg", ["-y", "-i", gp, "-vf", "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white", "-loop", "0", "-quality", "80", op]).then(() => true).catch(() => false);
    if (!ok) await execAsync("ffmpeg", ["-y", "-i", gp, "-vf", "scale=512:512", "-loop", "0", op]);
    const result = await fs.readFile(op);
    console.log(chalk.green("[GIF] OK, size:", result.length));
    return result;
  } finally { await fs.remove(gp).catch(() => {}); await fs.remove(op).catch(() => {}); }
}

async function upscaleImage(buffer) {
  try {
    const sharp = require("sharp"); const meta = await sharp(buffer).metadata();
    const w = meta.width || 512, h = meta.height || 512, s = Math.min(4, Math.floor(4096 / Math.max(w, h))) || 2;
    return await sharp(buffer).resize(w*s, h*s, { kernel: sharp.kernel.lanczos3, fastShrinkOnLoad: false }).sharpen({ sigma: 1.2, m1: 1.5, m2: 0.7 }).modulate({ brightness: 1.02, saturation: 1.1 }).jpeg({ quality: 95, progressive: true }).toBuffer();
  } catch (e) { console.log(chalk.yellow("[HD] Sharp:", e.message)); }
  try {
    const Jimp = require("jimp"); const img = await Jimp.read(buffer);
    const w = typeof img.getWidth === "function" ? img.getWidth() : img.width;
    const h = typeof img.getHeight === "function" ? img.getHeight() : img.height;
    const s = Math.min(4, Math.floor(4096 / Math.max(w, h))) || 2;
    if (typeof img.resize === "function") img.resize(w*s, h*s, Jimp.RESIZE_LANCZOS3 || "lanczos3");
    try { img.contrast(0.1); } catch { /* skip */ }
    const mime = Jimp.MIME_JPEG || "image/jpeg";
    return typeof img.getBuffer === "function" ? await img.getBuffer(mime) : await img.getBufferAsync(mime);
  } catch (e) { console.log(chalk.yellow("[HD] Jimp:", e.message)); }
  try {
    const form = new FormData();
    form.append("image", buffer, { filename: "img.jpg", contentType: "image/jpeg" });
    const res = await axios.post("https://api.deepai.org/api/torch-srgan", form, { headers: { ...form.getHeaders(), "api-key": "quickstart-QUdJIGlzIGNvbWluZy4uLi4K" }, timeout: 45000 });
    if (res.data && res.data.output_url) { const img = await axios.get(res.data.output_url, { responseType: "arraybuffer", timeout: 30000 }); return Buffer.from(img.data); }
  } catch (e) { console.log(chalk.yellow("[HD] DeepAI:", e.message)); }
  throw new Error("Semua metode upscale gagal.");
}

async function downloadTikTok(url) {
  const u = url.split("?")[0];
  try {
    const r = await axios.get("https://api.tiklydown.eu.org/api/download?url=" + encodeURIComponent(u), { timeout: 25000 });
    const v = (r.data.video && r.data.video.noWatermark) || (r.data.video && r.data.video.watermark);
    if (v) { const d = await axios.get(v, { responseType: "arraybuffer", timeout: 60000 }); return { buffer: Buffer.from(d.data), caption: r.data.title || "TikTok" }; }
  } catch { /* next */ }
  const r2 = await axios.get("https://tikwm.com/api/?url=" + encodeURIComponent(u) + "&hd=1", { timeout: 25000 });
  const d2 = r2.data && r2.data.data;
  if (!d2 || !d2.play) throw new Error("Link TikTok tidak ditemukan.");
  const v2 = await axios.get(d2.play, { responseType: "arraybuffer", timeout: 60000 });
  return { buffer: Buffer.from(v2.data), caption: d2.title || "TikTok" };
}

async function downloadTikTokAudio(url) {
  const u = url.split("?")[0];
  try {
    const r = await axios.get("https://api.tiklydown.eu.org/api/download?url=" + encodeURIComponent(u), { timeout: 25000 });
    const a = (r.data.music && r.data.music.play_url) || r.data.music;
    if (a) { const d = await axios.get(a, { responseType: "arraybuffer", timeout: 60000 }); return { buffer: Buffer.from(d.data), title: (r.data.music && r.data.music.title) || "TikTok Audio" }; }
  } catch { /* next */ }
  const r2 = await axios.get("https://tikwm.com/api/?url=" + encodeURIComponent(u) + "&hd=1", { timeout: 25000 });
  const d2 = r2.data && r2.data.data;
  if (!d2 || !d2.music) throw new Error("Audio tidak ditemukan.");
  const a2 = await axios.get(d2.music, { responseType: "arraybuffer", timeout: 60000 });
  return { buffer: Buffer.from(a2.data), title: (d2.music_info && d2.music_info.title) || "TikTok Audio" };
}

async function handleCommand(sock, msg, command, args) {
  const from = msg.key.remoteJid;
  switch (command) {
    case "rete": case "menu": case "help":
      await send(sock, from, { text: MENU_TEXT }, msg); break;

    case "22": {
      const text = args.join(" ").trim();
      if (!text) { await send(sock, from, { text: "📌 Contoh: *.22 haii owennn!!!!*" }, msg); break; }
      await send(sock, from, { text: "⏳ Membuat brat sticker..." }, msg);
      try { await send(sock, from, { sticker: await makeBratSticker(text) }, msg); }
      catch (e) { await send(sock, from, { text: "❌ Gagal: " + e.message }, msg); }
      break;
    }

    case "anim": {
      const text = args.join(" ").trim();
      if (!text) { await send(sock, from, { text: "📌 Contoh: *.anim haii owenn*\n_Teks muncul seperti diketik_ 🎬" }, msg); break; }
      await send(sock, from, { text: "⏳ Lagi Proses Brat Video... (10-20 detik)" }, msg);
      try { await send(sock, from, { sticker: await makeAnimTextSticker(text) }, msg); }
      catch (e) { await send(sock, from, { text: "❌ Brat Video gagal: " + e.message }, msg); }
      break;
    }

    case "gifstiker": {
      const url = args[0];
      if (!url || !/^https?:\/\//i.test(url)) { await send(sock, from, { text: "📌 Contoh: *.gifstiker https://media.giphy.com/xxx.gif*" }, msg); break; }
      await send(sock, from, { text: "⏳ Konversi GIF ke stiker animasi..." }, msg);
      try { await send(sock, from, { sticker: await makeGifSticker(url) }, msg); }
      catch (e) { await send(sock, from, { text: "❌ GIF stiker gagal: " + e.message }, msg); }
      break;
    }

    case "tt": {
      const url = args[0];
      if (!url || !/tiktok/i.test(url)) { await send(sock, from, { text: "📌 Contoh: *.tt https://vm.tiktok.com/xxx*" }, msg); break; }
      await send(sock, from, { text: "⏳ Mengunduh TikTok..." }, msg);
      try { const { buffer, caption } = await downloadTikTok(url); await send(sock, from, { video: buffer, caption: "🎵 " + caption + "\n> _VANS ASSISTANT_", mimetype: "video/mp4" }, msg); }
      catch (e) { await send(sock, from, { text: "❌ Gagal: " + e.message }, msg); }
      break;
    }

    case "mp3": {
      const url = args[0];
      if (!url || !/tiktok/i.test(url)) { await send(sock, from, { text: "📌 Contoh: *.mp3 https://vm.tiktok.com/xxx*" }, msg); break; }
      await send(sock, from, { text: "⏳ Mengunduh audio TikTok..." }, msg);
      try { const { buffer: ab, title } = await downloadTikTokAudio(url); await send(sock, from, { audio: ab, mimetype: "audio/mpeg", ptt: false, fileName: title + ".mp3" }, msg); }
      catch (e) { await send(sock, from, { text: "❌ Gagal: " + e.message }, msg); }
      break;
    }

    case "hd": {
      const ctx = msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
      const quoted = ctx && ctx.quotedMessage;
      if (!quoted) { await send(sock, from, { text: "📌 *Reply* foto dengan *.hd*!" }, msg); break; }
      if (getContentType(quoted) !== "imageMessage") { await send(sock, from, { text: "⚠️ Hanya untuk *foto*!" }, msg); break; }
      await send(sock, from, { text: "⏳ Meningkatkan kualitas foto..." }, msg);
      try {
        const fakeMsg = { key: { remoteJid: from, id: ctx.stanzaId, participant: ctx.participant || from, fromMe: false }, message: quoted };
        await send(sock, from, { image: await upscaleImage(await downloadMediaMessage(fakeMsg, "buffer", {}, { logger })), caption: "✅ Foto berhasil di-HD!\n> _VANS ASSISTANT_" }, msg);
      } catch (e) { await send(sock, from, { text: "❌ HD gagal: " + e.message }, msg); }
      break;
    }

    case "sh": {
      // Ambil contextInfo dari semua tipe pesan
      const msgObj = msg.message || {};
      let ctxInfo = null;
      for (const key of Object.keys(msgObj)) {
        const val = msgObj[key];
        if (val && typeof val === "object" && val.contextInfo) {
          ctxInfo = val.contextInfo;
          break;
        }
      }

      if (!ctxInfo || !ctxInfo.quotedMessage || !ctxInfo.stanzaId) {
        await send(sock, from, {
          text: "📌 Cara pakai *.sh*:\n1. Tekan & tahan pesan *View Once* 🔒\n2. Ketuk *Balas*\n3. Ketik *.sh* lalu kirim",
        }, msg);
        break;
      }

      const stanzaId = ctxInfo.stanzaId;
      console.log(chalk.gray("[SH] stanzaId:", stanzaId));

      // ── Ambil pesan ASLI dari msgStore (punya mediaKey lengkap) ──
      // quotedMessage dari contextInfo TIDAK punya mediaKey → tidak bisa decrypt
      const originalMsg = msgStore.get(stanzaId);
      console.log(chalk.gray("[SH] originalMsg found:", !!originalMsg));

      // Fungsi rekursif cari media di object message
      function findMedia(obj, depth) {
        if (!obj || typeof obj !== "object" || depth > 8) return null;
        for (const mt of ["imageMessage", "videoMessage", "audioMessage"]) {
          if (obj[mt] && obj[mt].mediaKey) return { type: mt, msgObj: obj };
        }
        const wrappers = ["viewOnceMessage","viewOnceMessageV2","viewOnceMessageV2Extension","ephemeralMessage","documentWithCaptionMessage"];
        for (const w of wrappers) {
          if (obj[w]) {
            const inner = obj[w].message || obj[w];
            const r = findMedia(inner, depth + 1);
            if (r) return r;
          }
        }
        for (const k of Object.keys(obj)) {
          if (k.endsWith("Message") && !["senderKeyDistributionMessage","messageContextInfo","deviceSentMessage"].includes(k)) {
            const r = findMedia(obj[k], depth + 1);
            if (r) return r;
          }
        }
        return null;
      }

      // Cari di pesan asli dulu (punya mediaKey), fallback ke quotedMessage
      let found = null;
      let sourceMsg = null;

      if (originalMsg && originalMsg.message) {
        found = findMedia(originalMsg.message, 0);
        sourceMsg = originalMsg;
        console.log(chalk.gray("[SH] from store:", found ? found.type : "null"));
      }

      if (!found) {
        // Fallback: coba dari quotedMessage (mungkin berhasil jika mediaKey ada)
        found = findMedia(ctxInfo.quotedMessage, 0);
        if (found) {
          // Buat fake message dengan key dari contextInfo
          sourceMsg = {
            key: {
              remoteJid: from,
              id: stanzaId,
              participant: ctxInfo.participant || undefined,
              fromMe: false,
            },
            message: found.msgObj,
          };
        }
        console.log(chalk.gray("[SH] from quoted:", found ? found.type : "null"));
      }

      if (!found) {
        await send(sock, from, {
          text: "⚠️ Tidak menemukan foto/video.\n\n_Pastikan reply pesan View Once (🔒) dan bot harus sudah menerima pesan tersebut terlebih dahulu._",
        }, msg);
        break;
      }

      await send(sock, from, { text: "⏳ Membuka View Once..." }, msg);
      try {
        const fakeMsg = sourceMsg.key
          ? sourceMsg  // sudah punya key lengkap (dari store)
          : {
              key: {
                remoteJid: from,
                id: stanzaId,
                participant: ctxInfo.participant || undefined,
                fromMe: false,
              },
              message: found.msgObj,
            };

        console.log(chalk.gray("[SH] fakeKey:", JSON.stringify(fakeMsg.key)));

        const mediaBuf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger });
        if (!mediaBuf || mediaBuf.length < 100) throw new Error("Media sudah expired atau kosong");

        console.log(chalk.green("[SH] Download OK, size:", mediaBuf.length));

        const mInfo = found.msgObj[found.type] || {};
        const emoji = found.type === "imageMessage" ? "📸" : found.type === "videoMessage" ? "🎥" : "🎵";
        const cap   = (mInfo.caption ? mInfo.caption + "\n" : "") + emoji + " View Once dibuka!\n> _VANS ASSISTANT_";

        if (found.type === "imageMessage") {
          await send(sock, from, { image: mediaBuf, caption: cap }, msg);
        } else if (found.type === "videoMessage") {
          await send(sock, from, { video: mediaBuf, caption: cap, mimetype: mInfo.mimetype || "video/mp4" }, msg);
        } else {
          await send(sock, from, { audio: mediaBuf, mimetype: mInfo.mimetype || "audio/ogg", ptt: !!mInfo.ptt }, msg);
        }
      } catch (e) {
        console.error(chalk.red("[SH ERROR]"), e.message);
        const isExpired = e.message.toLowerCase().includes("expired") || e.message.includes("empty media key") || e.message.includes("kosong");
        await send(sock, from, {
          text: isExpired
            ? "❌ *Gagal: Media key tidak tersedia.*\n\n_Bot harus *menerima* pesan view once tersebut dulu (ada di chat yang sama dengan bot). Kalau dari orang lain, forward view once ke chat yang ada botnya, lalu .sh_"
            : "⚠️ Gagal: " + e.message,
        }, msg);
      }
      break;
    }

    case "jadibot": {
      const rawNum = args[0] && args[0].replace(/[^0-9]/g, "");
      if (!rawNum) { await send(sock, from, { text: "📌 Contoh: *.jadibot 628xxxxxxxxxx*" }, msg); break; }
      const ex = jadiBotMap.get(rawNum);
      if (ex && ex.status !== "dead") { await send(sock, from, { text: "⚠️ Clone bot *+" + rawNum + "* sudah " + (ex.status === "online" ? "online ✅" : "dalam proses ⏳") + "!" }, msg); break; }
      jadiBotMap.set(rawNum, { status: "starting", retryCount: 0, lastPairSent: 0 });
      await send(sock, from, { text: "⏳ Memulai clone bot *+" + rawNum + "*..." }, msg);
      startJadiBot(rawNum, sock, from, msg).catch((e) => { jadiBotMap.set(rawNum, { status: "dead", retryCount: 0, lastPairSent: 0 }); send(sock, from, { text: "❌ Gagal: " + e.message }, msg); });
      break;
    }

    case "stopbot": {
      const rawNum = args[0] && args[0].replace(/[^0-9]/g, "");
      if (!rawNum) {
        const list = []; jadiBotMap.forEach((v, n) => { if (v.status !== "dead") list.push("• *+" + n + "* — " + (v.status === "online" ? "✅" : "⏳")); });
        await send(sock, from, { text: list.length ? "📋 *Clone Bot Aktif:*\n" + list.join("\n") + "\n\n📌 *.stopbot [nomor]*" : "ℹ️ Tidak ada clone bot aktif." }, msg); break;
      }
      const e = jadiBotMap.get(rawNum);
      if (!e || e.status === "dead") { await send(sock, from, { text: "⚠️ Clone bot *+" + rawNum + "* tidak ditemukan." }, msg); break; }
      jadiBotMap.set(rawNum, { ...e, status: "dead" });
      await fs.remove(path.join(__dirname, "session_jadibot_" + rawNum)).catch(() => {});
      await send(sock, from, { text: "🛑 Clone bot *+" + rawNum + "* dimatikan!" }, msg);
      break;
    }

    default: break;
  }
}

async function startJadiBot(phoneNumber, parentSock, notifyJid, quotedMsg) {
  const sp = path.join(__dirname, "session_jadibot_" + phoneNumber);
  await fs.ensureDir(sp);
  const { state, saveCreds } = await useMultiFileAuthState(sp);
  const { version } = await fetchLatestBaileysVersion();
  const jbs = jadiBotMap.get(phoneNumber) || { status: "starting", retryCount: 0, lastPairSent: 0 };
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    msgRetryCounterCache: msgRetry,
    // Anti-ban: browser fingerprint realistis
    browser: BOT_BROWSER,
    // Anti-ban: jangan broadcast online status terus-menerus
    markOnlineOnConnect: false,
    // Anti-ban: matikan fitur yang tidak perlu (kurangi traffic mencurigakan)
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    // Anti-ban: timeout wajar seperti client normal
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000 + Math.floor(Math.random() * 10000), // random 25-35 detik
    // Anti-ban: getMessage dari store agar tidak banjir request
    getMessage: async (key) => {
      const stored = msgStore.get(key.id);
      return stored ? stored.message : { conversation: "" };
    },
  });

  if (!sock.authState.creds.registered) {
    await sleep(3000);
    try {
      const clean = phoneNumber.replace(/[^0-9]/g, "");
      const code  = await sock.requestPairingCode(clean);
      const fmt   = code.slice(0, 4) + "-" + code.slice(4);
      const now   = Date.now();
      if (now - (jbs.lastPairSent || 0) > 60000) {
        jbs.lastPairSent = now; jadiBotMap.set(phoneNumber, jbs);
        await send(parentSock, notifyJid, { text: "🔑 *PAIRING CODE +*" + clean + "\n\n➤  *" + fmt + "*\n\n1. WA di HP *+" + clean + "*\n2. ⋮ → Perangkat Tertaut\n3. Tautkan Perangkat → Tautkan dgn nomor telepon\n4. Masukkan: *" + fmt + "*\n\n⏰ _Berlaku 60 detik!_" }, quotedMsg);
      }
      jbs.status = "pairing"; jadiBotMap.set(phoneNumber, jbs);
    } catch (e) { await send(parentSock, notifyJid, { text: "❌ Gagal pairing: " + e.message }, quotedMsg); jadiBotMap.set(phoneNumber, { ...jbs, status: "dead" }); return; }
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = new Boom(lastDisconnect && lastDisconnect.error).output.statusCode;
      const cur  = jadiBotMap.get(phoneNumber) || jbs;
      if (code === DisconnectReason.loggedOut || code === 403 || code === 408 || code === 401) {
        if (code === DisconnectReason.loggedOut || code === 401) await fs.remove(sp).catch(() => {});
        jadiBotMap.set(phoneNumber, { ...cur, status: "dead" });
        if (code === 408) await send(parentSock, notifyJid, { text: "⏰ Pairing expired. Ketik *.jadibot " + phoneNumber + "* lagi." });
        return;
      }
      cur.retryCount = (cur.retryCount || 0) + 1;
      if (cur.retryCount > 3) { jadiBotMap.set(phoneNumber, { ...cur, status: "dead" }); return; }
      jadiBotMap.set(phoneNumber, { ...cur, status: "starting" });
      setTimeout(() => startJadiBot(phoneNumber, parentSock, notifyJid, quotedMsg), 8000);
    } else if (connection === "open") {
      jadiBotMap.set(phoneNumber, { ...(jadiBotMap.get(phoneNumber) || jbs), status: "online", retryCount: 0 });
      await send(parentSock, notifyJid, { text: "✅ Clone bot *+" + phoneNumber + "* online!" });
    }
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg || !msg.message || msg.key.fromMe || isJidBroadcast(msg.key.remoteJid)) continue;
      const body = extractText(msg); if (!body.startsWith(PREFIX)) continue;
      const parts = body.slice(PREFIX.length).trim().split(/ +/);
      handleCommand(sock, msg, parts.shift().toLowerCase(), parts).catch((e) => console.error(chalk.red("[JADIBOT CMD]"), e.message));
    }
  });
}

async function startBot(phoneNumber) {
  phoneNumber = phoneNumber || BOT_NUMBER;
  await fs.ensureDir(SESSION_DIR); await fs.ensureDir(TMP_DIR);
  const { state, saveCreds }  = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(chalk.gray("[VANS] Baileys v" + version.join(".") + " isLatest:" + isLatest));
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    msgRetryCounterCache: msgRetry,
    // Anti-ban: browser fingerprint realistis
    browser: BOT_BROWSER,
    // Anti-ban: jangan broadcast online status terus-menerus
    markOnlineOnConnect: false,
    // Anti-ban: matikan fitur yang tidak perlu (kurangi traffic mencurigakan)
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    // Anti-ban: timeout wajar seperti client normal
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000 + Math.floor(Math.random() * 10000), // random 25-35 detik
    // Anti-ban: getMessage dari store agar tidak banjir request
    getMessage: async (key) => {
      const stored = msgStore.get(key.id);
      return stored ? stored.message : { conversation: "" };
    },
  });

  if (!sock.authState.creds.registered) {
    await sleep(3000);
    try {
      const clean = phoneNumber.replace(/[^0-9]/g, "");
      const code  = await sock.requestPairingCode(clean);
      console.log(chalk.yellow("┌────────────────────────────────────┐"));
      console.log(chalk.yellow("│ PAIRING CODE : " + clean));
      console.log(chalk.green.bold("│ => " + code + " <="));
      console.log(chalk.yellow("│ WA → Linked Devices → Link w/ Number"));
      console.log(chalk.yellow("└────────────────────────────────────┘"));
    } catch (e) { console.error(chalk.red("[PAIRING ERROR]"), e.message); }
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = new Boom(lastDisconnect && lastDisconnect.error).output.statusCode;
      if (code === DisconnectReason.loggedOut) await fs.remove(SESSION_DIR).catch(() => {});
      if (code !== 403) setTimeout(() => startBot(phoneNumber), 5000);
    } else if (connection === "open") {
      console.log(chalk.green("[VANS] ONLINE!"));
    } else if (connection === "connecting") {
      console.log(chalk.yellow("[VANS] Menghubungkan..."));
    }
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    // Simpan semua pesan ke msgStore agar .sh bisa ambil mediaKey asli
    for (const m of messages) {
      if (!m || !m.key || !m.key.id) continue;
      msgStore.set(m.key.id, m);
      // Buang pesan lama jika melebihi batas
      if (msgStore.size > MSG_STORE_MAX) {
        const oldest = msgStore.keys().next().value;
        msgStore.delete(oldest);
      }
    }
    for (const msg of messages) {
      if (!msg || !msg.message || !msg.key.remoteJid) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const from     = msg.key.remoteJid;
      const isFromMe = !!msg.key.fromMe;  // pesan dikirim dari HP kamu sendiri

      // Proses SEMUA pesan: dari kamu sendiri (fromMe) MAUPUN dari orang lain
      // Tidak ada filter fromMe — kamu bisa pakai perintah di chat manapun

      const body = extractText(msg);
      // Anti-ban: rate limit — max 8 perintah per 60 detik per JID
      if (!checkRateLimit(from)) {
        console.log(chalk.yellow("[RATELIMIT]"), from);
        // Diam saja, jangan balas — balas pun bisa trigger spam detection
        continue;
      }

      // Anti-ban: human-like delay sebelum proses
      await humanDelay();

      if (!body.startsWith(PREFIX)) continue;

      const parts   = body.slice(PREFIX.length).trim().split(/ +/);
      const command = parts.shift().toLowerCase();
      const args    = parts;

      console.log(chalk.cyan("[CMD] " + (isFromMe ? "ME→" + from : from) + " → ." + command + " " + args.join(" ")));
      sock.readMessages([msg.key]).catch(() => {});
      // Anti-ban: online singkat lalu offline (jangan online terus seperti robot)
      sock.sendPresenceUpdate("available", from).catch(() => {});
      setTimeout(() => sock.sendPresenceUpdate("unavailable", from).catch(() => {}), 3000 + Math.random() * 2000);
      if (!isFromMe) sock.sendPresenceUpdate("composing", from).catch(() => {});

      handleCommand(sock, msg, command, args)
        .catch((err) => { console.error(chalk.red("[ERR] ." + command), err.message); send(sock, from, { text: "❌ Error: " + err.message }, msg).catch(() => {}); })
        .finally(() => { if (!isFromMe) setTimeout(() => sock.sendPresenceUpdate("paused", from).catch(() => {}), 2000); });
    }
  });
  return sock;
}

(async () => { printBanner(); await startBot(BOT_NUMBER); })();
