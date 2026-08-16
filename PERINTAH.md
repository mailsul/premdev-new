# PremDev — Perintah Penting

---

## Push ke GitHub (dari Replit Shell)

```bash
cd /home/runner/workspace
git add -A
git commit -m "update"
git push origin main
```

---

## Deploy ke VPS (setelah push GitHub)

```bash
ssh root@flixprem.org
cd /opt/premdev && sudo git pull origin main
sudo docker compose pull app
sudo docker compose up -d app
```

Kalau ada perubahan Caddy (domain, Caddyfile):
```bash
sudo docker compose up -d caddy
```

Kalau ada perubahan script backup/restore:
```bash
sudo cp infra/backup.sh  /usr/local/sbin/premdev-backup
sudo cp infra/restore.sh /usr/local/sbin/premdev-restore
chmod 755 /usr/local/sbin/premdev-backup /usr/local/sbin/premdev-restore
```

---

## Backup Manual

```bash
ssh root@flixprem.org
sudo premdev-backup
```

Cek hasil backup:
```bash
cat /var/log/premdev-backup.log | tail -30
```

---

## Lihat Snapshot yang Tersedia di R2

```bash
ssh root@flixprem.org
rclone lsf r2:premdev-backup/daily/
rclone lsf r2:premdev-backup/weekly/
```

---

## Restore dari R2 (VPS lama atau baru)

```bash
# Ganti 20260507-193701 dengan timestamp snapshot yang diinginkan
sudo premdev-restore daily/20260507-193701
```

Script akan otomatis:
1. Download dari R2
2. Restore SQLite + MySQL + workspace + .env
3. Restart semua container

---

## Migrasi ke VPS Baru dari 0

> Yang dibutuhkan: IP VPS baru, akses SSH, akun Cloudflare, akun GitHub.
> Estimasi waktu: **20–30 menit**.

---

### Langkah 0 — Ambil file .env dari R2 (WAJIB PERTAMA)

File `.env` berisi semua secret (JWT, enkripsi, R2 key, dll).
Tanpa ini data lama tidak bisa dibaca walau sudah di-restore.

**Cara download .env dari Cloudflare R2 dashboard:**
1. Buka [dash.cloudflare.com](https://dash.cloudflare.com) → R2 → bucket `premdev-backup`
2. Masuk folder `daily/` → pilih snapshot terbaru (folder timestamp terbesar)
3. Klik file `premdev-env-*.env` → klik tombol **Download**
4. Simpan file itu di laptop kamu

---

### Langkah 1 — Arahkan DNS ke IP VPS baru

Di Cloudflare, ubah A record semua domain ke IP VPS baru (lakukan ini dulu supaya SSL cert bisa dibuat):

| Record | Type | Value |
|--------|------|-------|
| `flixprem.org` | A | IP VPS baru |
| `*.flixprem.org` | A | IP VPS baru |
| `netprem.org` | A | IP VPS baru |
| `*.netprem.org` | A | IP VPS baru |

> Mode: **DNS only** (awan abu-abu, bukan orange). Tunggu 1–2 menit sampai propagasi.

---

### Langkah 2 — SSH ke VPS baru, install Docker

```bash
ssh root@IP_VPS_BARU

# Update sistem
apt-get update && apt-get install -y git curl

# Install Docker
curl -fsSL https://get.docker.com | sh
```

---

### Langkah 3 — Clone repo dari GitHub

```bash
git clone https://github.com/maraazn069/premdev /opt/premdev
```

---

### Langkah 4 — Upload file .env ke VPS baru

Dari laptop kamu (bukan dari dalam VPS), jalankan:

```bash
# Ganti IP_VPS_BARU dan path file .env yang kamu download tadi
scp ~/Downloads/premdev-env-20260507-194530.env root@IP_VPS_BARU:/opt/premdev/.env
```

> Kalau pakai Windows, bisa pakai **WinSCP** atau **MobaXterm** untuk upload file ke `/opt/premdev/.env`

---

### Langkah 5 — Jalankan install.sh

```bash
ssh root@IP_VPS_BARU

cd /opt/premdev/infra
sudo bash install.sh
```

install.sh akan membaca `.env` yang sudah ada dan menggunakannya sebagai nilai default.
**Tekan Enter saja untuk semua pertanyaan** — nilai lama akan terpakai otomatis.

Proses ini:
- Install Docker Compose, rclone, Caddy
- Setup direktori data
- Setup cron backup otomatis
- Jalankan semua container

---

### Langkah 6 — Restore data dari R2

```bash
# Lihat snapshot yang tersedia
rclone lsf r2:premdev-backup/daily/

# Restore snapshot terbaru (ganti timestamp sesuai output di atas)
sudo premdev-restore daily/20260507-194530
```

Script akan otomatis:
1. Download 4 file dari R2 (env, mysql, sqlite, workspaces)
2. Restore database MySQL + SQLite
3. Restore semua file workspace user
4. Restart semua container

Tunggu sampai selesai (~2–5 menit tergantung ukuran workspace).

---

### Langkah 7 — Verifikasi

```bash
# Cek semua container jalan
docker compose -f /opt/premdev/docker-compose.yml ps

# Cek log app
docker compose -f /opt/premdev/docker-compose.yml logs app --tail=30

# Cek SSL cert (Caddy otomatis request cert baru ke Let's Encrypt)
docker compose -f /opt/premdev/docker-compose.yml logs caddy --tail=30
```

Buka browser → `https://flixprem.org` — seharusnya sudah bisa login dengan akun lama.

---

### Ringkasan file yang dibutuhkan untuk migrasi

| Sumber | File | Keterangan |
|--------|------|------------|
| R2 dashboard | `premdev-env-*.env` | Semua secret — wajib diambil manual |
| R2 (otomatis via restore) | `premdev-mysql-*.sql.gz` | Database user & workspace |
| R2 (otomatis via restore) | `premdev-sqlite-*.sqlite.gz` | Data app (audit, sessions) |
| R2 (otomatis via restore) | `premdev-workspaces-*.tar.gz` | File kode semua user |
| GitHub | repo code | Diclone ulang — tidak perlu backup |

> **Intinya:** yang perlu kamu pegang sendiri hanya file `.env`. Sisanya diambil otomatis dari R2.

**Estimasi waktu total: 20–30 menit.**

---

## Tambah Domain Baru (setelah setup satu kali selesai)

1. Di Cloudflare: tambah A record `*` dan `namadomain.com` → IP VPS (DNS only)
2. Di Admin panel → Domains → tambah domain
3. Selesai — Caddy otomatis buat config + minta SSL cert

---

## Cek Log

```bash
# Log app
sudo docker compose logs app -f --tail=50

# Log caddy (termasuk SSL cert)
sudo docker compose logs caddy -f --tail=50

# Log backup
cat /var/log/premdev-backup.log | tail -30
```

---

## Restart Darurat

```bash
ssh root@flixprem.org
cd /opt/premdev
sudo docker compose down && sudo docker compose up -d
```
