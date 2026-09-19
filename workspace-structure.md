# Isi Workspace Baru di PremDev

Dokumen ini menjelaskan isi dasar workspace baru di PremDev, fungsi singkatnya, serta perbedaan antara komponen yang disediakan PremDev dan file yang bergantung pada template project.

## 1. Komponen dasar yang disediakan PremDev

### Root workspace

Semua file project berada di root workspace yang di dalam container disebut:

```text
/workspace
```

Command seperti `python3 main.py`, `php index.php`, atau `npm run dev` dijalankan dari folder ini.

Workspace setiap user berjalan di container terisolasi sendiri, bukan langsung di host VPS.

### `.git`

PremDev menyiapkan repository Git lokal jika memungkinkan.

Fungsinya:

- Menyimpan riwayat perubahan.
- Melihat diff file.
- Membuat checkpoint.
- Menjalankan `git status`, `git log`, dan `git diff`.
- Mendukung fitur Git di editor.

Folder ini biasanya tersembunyi dari tampilan normal.

### `.gitignore`

PremDev membuat `.gitignore` dasar jika belum ada.

File ini biasanya mengecualikan:

```text
node_modules/
__pycache__/
*.pyc
.env
.env.*
dist/
build/
.cache/
*.log
.premdev
```

Tujuannya agar dependency, cache, secret, hasil build, dan log tidak ikut masuk ke Git.

### `.premdev`

`.premdev` adalah konfigurasi utama workspace PremDev.

Isinya dapat menjelaskan:

- Command untuk menjalankan project.
- Bahasa pemrograman.
- File entry point.
- Module atau runtime yang dibutuhkan.
- Environment variable.
- Port aplikasi.
- Konfigurasi process.

Contoh:

```json
{
  "run": "python3 main.py",
  "language": "python",
  "entrypoint": "main.py",
  "modules": ["python-3.12"],
  "port": 8000
}
```

File ini membantu PremDev dan AI memahami cara menjalankan project.

### `README.md`

Untuk workspace tipe Blank, PremDev membuat `README.md` dasar.

Fungsinya untuk dokumentasi project, misalnya:

- Nama aplikasi.
- Cara menjalankan project.
- Daftar fitur.
- Struktur folder.
- Catatan instalasi.

## 2. Isi berdasarkan template

Isi file awal bergantung pada template yang dipilih saat membuat workspace.

### Template Blank

Biasanya berisi:

```text
README.md
.premdev
.gitignore
.git/
```

Tidak ada aplikasi siap jalan. File aplikasi perlu dibuat sendiri.

### Template Static HTML

Biasanya berisi:

```text
index.html
.premdev
.gitignore
.git/
```

Digunakan untuk website HTML, CSS, dan JavaScript sederhana.

### Template Node.js

Biasanya berisi:

```text
index.js
package.json
.premdev
.gitignore
.git/
```

Digunakan untuk aplikasi Node.js.

### Template Express

Biasanya berisi:

```text
index.js
package.json
.premdev
.gitignore
.git/
```

Digunakan untuk backend Express.

### Template React

Biasanya berisi:

```text
package.json
index.html
vite.config.js
src/main.jsx
.premdev
.gitignore
.git/
```

Digunakan untuk aplikasi frontend React dengan Vite.

### Template Python

Biasanya berisi:

```text
main.py
.premdev
.gitignore
.git/
```

Digunakan untuk program Python sederhana.

### Template Flask

Biasanya berisi:

```text
app.py
requirements.txt
.premdev
.gitignore
.git/
```

Digunakan untuk aplikasi web Python Flask.

### Template PHP

Biasanya berisi:

```text
index.php
.premdev
.gitignore
.git/
```

Digunakan untuk aplikasi PHP sederhana.

Contoh command untuk menjalankan PHP:

```bash
php -S 0.0.0.0:$PORT -t .
```

## 3. Folder yang dibuat saat dibutuhkan

### `.premdev-data`

Folder ini berisi data pendukung PremDev dan AI yang dibuat saat diperlukan.

Contohnya:

```text
.premdev-data/instructions.md
.premdev-data/memory.md
```

Fungsinya:

- Menyimpan instruksi khusus workspace.
- Menyimpan memory AI.
- Menyimpan data internal assistant.
- Membantu AI memahami konteks project.

### Folder `logs`

Folder `logs` tidak wajib dibuat pada workspace baru. Folder ini biasanya dibuat oleh aplikasi jika project membutuhkan penyimpanan log sendiri.

Log runtime utama PremDev ditangani oleh Workflows dan container.

### Folder backup

Backup dan checkpoint dikelola oleh PremDev. Data backup tidak harus muncul sebagai folder `backup_db` di File Explorer.

Fitur backup dapat digunakan melalui:

```text
Tools → Checkpoints
Tools → Backup / Restore
```

## 4. Tools yang tersedia di UI workspace

### File Explorer

Untuk:

- Melihat file dan folder.
- Membuat file atau folder.
- Upload file.
- Download ZIP.
- Rename dan memindahkan file.
- Mencari file.

### Editor

Untuk:

- Membuka file.
- Mengedit kode.
- Membuka beberapa tab.
- Membuka split editor.
- Membandingkan file.
- Mencari dan mengganti teks.
- Melihat diff perubahan.

### Workflows

Untuk:

- Menjalankan process project.
- Melihat output aplikasi.
- Melihat log process.
- Menjalankan beberapa process.
- Mengetahui process yang aktif atau error.

### Shell

Untuk menjalankan command di container workspace, misalnya:

```bash
ls
python3 main.py
php index.php
npm install
git status
```

Shell ini bukan terminal host VPS.

### Run / Preview

Untuk:

- Menjalankan aplikasi.
- Membuka preview website.
- Melihat port aktif.
- Menguji aplikasi dari browser.

### Database

Untuk:

- Melihat database workspace.
- Menjalankan query.
- Mengecek tabel.
- Membantu setup schema database.

### AI Panel

Untuk:

- Menjelaskan kode.
- Membuat file.
- Memperbaiki error.
- Menjalankan command.
- Membaca struktur project.
- Membantu setup aplikasi.
- Menyimpan memory dan instruksi workspace.

### Cron Jobs

Untuk membuat scheduler per workspace.

Contoh:

```text
*/5 * * * * → php index.php
```

Cron dijalankan oleh scheduler API terpusat di container workspace. Cron tidak bergantung pada Shell browser yang tetap terbuka.

### Logs & Diagnostics

Untuk:

- Melihat log runtime.
- Mengecek error.
- Refresh log.
- Membantu analisis masalah.
- Membuka Workflows.

### Resource Monitor

Untuk memantau:

- CPU.
- Memory.
- Disk.
- Resource container workspace.

### Ports & Preview

Untuk:

- Melihat port aplikasi.
- Melihat alamat preview.
- Mengecek port yang sedang listen.
- Mengatur akses preview.

### Secrets

Untuk menyimpan:

- API key.
- Password database.
- Token.
- Environment variable rahasia.

Secret sebaiknya tidak ditulis langsung di `config.json`, `README.md`, atau file yang akan di-commit.

### Checkpoints

Untuk membuat snapshot workspace.

Berguna untuk:

- Menyimpan kondisi sebelum perubahan besar.
- Melihat file yang berubah.
- Rollback ke kondisi sebelumnya.

### Backup / Restore

Untuk:

- Export workspace ke ZIP.
- Import ZIP.
- Memulihkan file project.
- Membuat backup manual.

### Git

Untuk:

- Melihat status perubahan.
- Membuat commit.
- Melihat diff.
- Melihat riwayat.
- Sinkronisasi dengan repository remote.

## Struktur ideal workspace

### Project bot Python

```text
bot-workspace/
├── .git/
├── .gitignore
├── .premdev
├── README.md
├── main.py
├── runner.py
├── requirements.txt
├── config_loader.py
├── server/
├── static/
├── logs/
└── tests/
```

### Project PHP

```text
php-workspace/
├── .git/
├── .gitignore
├── .premdev
├── README.md
├── index.php
├── config.php
├── src/
├── public/
├── storage/
└── tests/
```

Fondasi workspace PremDev terdiri dari:

```text
/workspace
.git
.gitignore
.premdev
README.md untuk template Blank
container runtime
Git lokal
UI editor dan tools PremDev
```