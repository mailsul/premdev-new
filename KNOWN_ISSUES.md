# PremDev — Bug Terbuka

Dokumen ini mencatat masalah yang masih dapat muncul di production dan belum
dianggap selesai hanya karena sebagian mitigasi sudah diterapkan.

Terakhir diperbarui: 21 September 2026

## 1. Refresh kadang mengarah ke logout atau login timeout

**Status:** Terbuka — mitigasi sudah ada, verifikasi production belum konsisten.

### Gejala

- Setelah refresh, tab kadang kembali ke `/login`.
- Form login dapat menampilkan `Request timeout. Please try again.` meskipun
  endpoint health dari VPS membalas cepat.
- Browser lain kadang dapat login, sedangkan browser/tab lama masih bermasalah.

### Bukti yang sudah diketahui

- App container sehat.
- Caddy sehat setelah restart.
- `https://app.flixprem.org/api/health` pernah membalas `HTTP=200` dalam sekitar
  0,34 detik.
- Soft deploy mengganti container `app` tanpa me-restart Caddy; restart Caddy
  dapat memperbaiki koneksi upstream lama.

### Mitigasi saat ini

- Request `/auth/me` memakai timeout pendek agar boot tidak menggantung.
- Error jaringan atau timeout `/auth/me` tidak lagi langsung menghapus user cache.
- Hanya respons `401` yang dianggap sebagai session benar-benar tidak valid.
- Panel workspace yang tidak aktif tidak lagi membuka WebSocket/iframe saat
  reload.

### Yang masih perlu diselesaikan

- Cari tahu mengapa request `POST /api/auth/login` kadang tidak sampai ke app
  atau tertahan di browser/Caddy.
- Tambahkan telemetry request ID yang mudah dicocokkan antara browser, Caddy,
  dan log app.
- Pastikan prosedur deploy app selalu melakukan refresh upstream Caddy tanpa
  perlu full redeploy.
- Uji berulang pada browser/tab lama, browser baru, dan setelah app container
  direcreate.

### Cara mengumpulkan bukti

```bash
cd /opt/premdev
sudo docker compose --env-file /opt/premdev/.env \
  -f /opt/premdev/docker-compose.yml logs --tail=200 app

sudo docker compose --env-file /opt/premdev/.env \
  -f /opt/premdev/docker-compose.yml logs --tail=200 caddy
```

Saat error terjadi, catat apakah request `POST /api/auth/login` muncul di log
app. Jika tidak muncul, masalah berada di antara browser dan Caddy, bukan di
validasi username/password.

## 2. Agent tetap berhenti atau membatasi tindakan setelah diminta tanpa batasan

**Status:** Terbuka — penyebab spesifik belum terisolasi.

### Gejala

- Pengguna meminta agent melanjutkan pekerjaan tanpa batasan buatan dari
  PremDev.
- Agent tetap berhenti, menolak melanjutkan, atau tidak menjalankan langkah
  berikutnya.
- UI dapat menampilkan error merah seperti `PremDev internal rate limit
  reached` atau error internal provider setelah beberapa aksi.
- Dari sisi pengguna, pesan tersebut terlihat seperti agent mengabaikan
  instruksi “jangan diberi batasan”.

### Klarifikasi penting

“Tanpa batasan” harus berarti batas yang dapat dikonfigurasi pengguna, seperti
budget token atau jumlah request AI, tidak menghentikan agent secara diam-diam.
Itu tidak berarti menghapus timeout, batas output, isolasi container, validasi
command berbahaya, atau proteksi keamanan.

### Kemungkinan sumber masalah

1. Rate limiter internal PremDev masih aktif walaupun setting AI terlihat
   unlimited.
2. Budget token `0` belum diteruskan secara konsisten ke semua adapter provider.
3. Timeout provider atau timeout first-token dianggap sebagai penolakan agent,
   bukan kegagalan sementara yang dapat dijelaskan.
4. Error provider, 9Router, dan rate limiter internal dirangkum menjadi pesan
   yang terlalu umum.
5. Agent menerima instruksi, tetapi loop recovery atau policy prompt
   memasang batas lain yang tidak terlihat di UI.

### Yang perlu diselesaikan

- Tampilkan sumber error yang jelas: `internal limiter`, `provider/9Router`,
  `provider timeout`, `token budget`, atau `safety/runtime guard`.
- Sertakan request/run ID pada kartu error dan log server.
- Tambahkan test bahwa setting unlimited memang menghasilkan `0`/parameter
  omitted pada setiap adapter provider.
- Bedakan “agent menolak instruksi” dari “request gagal sebelum agent memberi
  respons”.
- Tambahkan status run yang jelas ketika agent berhenti: `completed`,
  `blocked`, `rate_limited`, `provider_error`, atau `timed_out`.
- Simpan alasan penghentian pada riwayat agent agar tidak terlihat seperti
  agent ngeyel tanpa sebab.

### Bukti yang perlu dicatat saat terjadi lagi

- Prompt lengkap yang dikirim.
- Model/provider aktif.
- Nilai setting budget dan rate limiter saat itu.
- Waktu kejadian dan request/run ID.
- Pesan error merah lengkap.
- Apakah command terakhir benar-benar dijalankan di workspace.

## Catatan prioritas

Masalah pertama memengaruhi akses masuk dan refresh session, sehingga
prioritasnya lebih tinggi. Masalah kedua memengaruhi kepercayaan terhadap agent
dan membutuhkan pemisahan antara batas konfigurasi, error provider, timeout,
dan guard keamanan sebelum perubahan perilaku agent dilakukan.