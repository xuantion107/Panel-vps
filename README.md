# ZangBot 🤖

Bot Telegram dengan fitur Puss Kontak WhatsApp.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Konfigurasi
Edit file `zang.js` baris paling atas:
```js
const BOT_TOKEN = 'ISI_BOT_TOKEN_DISINI';
```
Atau set environment variable:
```
BOT_TOKEN=token_kamu
```

### 3. Jalankan
```bash
npm start
```

---

## Deploy di Panel (Pteroductyl / Railway)

### Environment Variable
Tambahkan di panel:
```
BOT_TOKEN = token_telegram_kamu
```

### Start Command
```
npm start
```

### Node Version
Minimal **Node.js 18+**

---

## Fitur

| Fitur | Keterangan |
|---|---|
| Tambah Sender | Login WA via QR atau Pairing Code |
| Puss Kontak | Blast pesan ke semua kontak grup WA |
| Owner | Link ke admin @XIXI8778 |
| Upgrade Premium | Info paket & harga |

---

## Catatan Penting
- Puss Kontak hanya bisa digunakan **setelah login sender**
- Anti-spam aktif: delay 3–5 detik antar pesan
- Session WA tersimpan di folder `sessions/`
