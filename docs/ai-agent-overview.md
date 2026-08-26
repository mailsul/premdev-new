# 🤖 AI Agent PremDev — Overview Lengkap

> Dokumen ini menjelaskan seluruh kondisi AI agent di PremDev: arsitektur, action blocks, izin akses filesystem & database, orchestrator, rate limit, memory, checkpoint, batasan keamanan, dan panduan perbaikan.

---

## 1. Alur Kerja (Pipeline)

```
User kirim pesan
      │
      ▼
POST /api/ai/chat
  ├─ Validasi ownership workspace
  ├─ Build system prompt (SYSTEM + AUTO_PILOT_PROMPT)
  ├─ Inject konteks:
  │    ├─ Snapshot workspace (file tree)
  │    ├─ Project instructions (.premdev-data/instructions.md) → max 4 KiB
  │    ├─ AI memory (.premdev-data/memory.md)           → max 6 KiB
  │    ├─ Semantic code snippets (BM25 search)
  │    └─ File aktif di editor                          → max 200 baris
  ├─ Trim history (max 18.000 char / 24 pesan)
  └─ Return jobId langsung → stream via SSE
         │
         ▼
GET /api/chat/jobs/:id/stream?offset=N
  ├─ Heartbeat tiap 20 detik
  ├─ Resume-able (offset = byte terakhir diterima)
  └─ Abort via POST /chat/jobs/:id/abort

Response AI mengandung action blocks
      │
      ▼
Orchestrator (AIChat.tsx) parse & eksekusi action blocks
  ├─ autonomous=true → auto-run tanpa konfirmasi
  ├─ Tiap action → POST ke endpoint spesifik di /api/workspaces/:id/*
  └─ Hasil action → dimasukkan ke history → AI lanjut iterasi berikutnya
```

---

## 2. Semua Action Block + Endpoint yang Dipanggil

| Action | Endpoint | Batas / Catatan |
|---|---|---|
| `bash:run` | `POST /exec` | Command max **4.000 char**, timeout **120 detik** → paksa kill, output cap **2.000 char** |
| ` ```file:path` ` ` | `POST /files/create` → `PUT /files` | Overwrite penuh file, baca max **5 MiB** |
| `patch:path` | `POST /files/patch` | Search/replace, support `replaceAll` |
| `file:delete:path` | `POST /files/delete` | Recursive delete folder/file |
| `file:mkdir:path` | `POST /files/create` type=dir | Buat folder + parents |
| `file:rename:old => new` | `POST /files/rename` | Rename / move |
| `search:run` | `POST /files/search` | Max **100 hits**, 2.000 file di-scan, timeout literal **1,5 dtk** / regex **750 ms**, regex max 200 char |
| `diag:run` | `POST /files/diagnostics` | Auto-detect tsc / eslint / ruff / pyflakes |
| `test:run` | `POST /test` | Auto-detect npm test / pytest / go test / cargo test |
| `web:search` | `POST /api/ai/web-search` | DuckDuckGo |
| `web:fetch` | `POST /api/ai/web-fetch` | Jina Reader, output cap **12 KiB** |
| `memory:save` | `POST /api/ai/memory/compact` | Compact+deduplicate via LLM, max note **4.000 char**, max 80 baris, fallback raw append |
| `workspace:setRun` | `POST /config/patch` | Hanya ubah field `run`, secrets di `.premdev` **tidak disentuh** |
| `workspace:setEnv` | `POST /config/patch` | Merge (bukan overwrite) ke `env` object di `.premdev` |
| `workspace:restart` | `POST /restart` | Stop proses + spawn ulang. Auto-inject: `sleep 2 && curl -fsSI http://localhost:$PORT/` |
| `workspace:checkpoint` | `POST /checkpoints` | Tar-gz snapshot workspace, simpan ke SQLite, **prune ke 20/workspace** |
| `db:query` | `POST /db/query` | MySQL workspace sendiri, max **200 rows** (cap 50 saat autonomous), output cap **12 KiB** |
| `open:path` | *(browser event)* | Buka file di editor, tidak ada API call ke server |

---

## 3. Orchestrator (Loop Otonom)

```
User kirim → iterationRef reset ke 0
       │
       ▼
Loop:
  1. Tunggu streaming AI selesai
  2. Parse semua action blocks dari response terakhir
  3. autonomous=true → eksekusi semua action otomatis (tanpa Approve/Skip)
  4. Loop detection (loop-detector.ts):
       a. Fingerprint tiap action (content-sensitive hash, bukan hanya path)
       b. Flag jika fingerprint yang sama muncul di 3 batch berturut-turut
       c. Flag juga regression loop: action kind+target yang sama gagal lalu
          langsung diulang di batch berikutnya
  5. Hasil semua action → append ke history sebagai tool result
  6. Buat "continue" message → kirim ulang ke AI
  7. iterationRef++
  8. Ulangi dari step 1

Berhenti jika:
  - Tidak ada action block baru (AI selesai)
  - Iterasi mencapai batas max
  - User klik Stop
  - Loop terdeteksi (step 4)
  - stoppedRef = true
```

### Max iterasi

| | |
|---|---|
| **Default** | **15 iterasi** |
| Cara ubah | `localStorage.setItem("premdev:ai:maxIterations", "30")` |
| Server-side cap | ❌ Tidak ada — hanya client-side |

---

## 4. Token Budget & Batas Context

| Parameter | Nilai |
|---|---|
| Max output token — chat biasa | **4.096 token** |
| Max output token — autopilot | **16.384 token** |
| Max total input char | **120.000 char** |
| Max history | 18.000 char / 24 pesan |
| Max 1 pesan di history | 6.000 char |
| Kompresi history | 4 tool result terakhir verbatim, yang lama diringkas |
| Project instructions | max 4 KiB |
| AI memory | max 6 KiB |
| File aktif di editor | max 200 baris |

---

## 5. Filesystem — Izin Akses

### ✅ BOLEH

- Baca semua file di workspace (max 5 MiB/file)
- Tulis / overwrite file apapun (**kecuali `.premdev`**)
- Patch file dengan search/replace
- Hapus file dan folder secara rekursif
- Buat folder baru (dengan parents)
- Rename / move file dalam workspace
- Akses file via path absolut dalam workspace boundary

### ❌ TIDAK BOLEH

- Path traversal (`../../`) → ditolak server-side
- Mutasi melalui symlink → ditolak (`safeWritePath` check)
- Overwrite `.premdev` langsung via `file:` → diblokir di parser (AIChat.tsx)
- Akses workspace user lain (ownership check per request)
- Install OS packages (`apt` / `yum` / `apk` tidak tersedia di runtime)
- `recursive chmod` di workspace (dilarang di system prompt)

---

## 6. Database — Izin Akses

### ✅ BOLEH (autonomous mode — read-only)

- SELECT, WITH, EXPLAIN, SHOW, DESCRIBE
- Max **50 rows** per query (di-cap server-side saat `autonomous: true`)

### ✅ BOLEH (human / Query tab — tidak dibatasi ke read-only)

- SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, dll
- Max **200 rows** per query, output cap **12 KiB**

### ❌ TIDAK BOLEH (autonomous mode — diblokir `checkSqlReadOnly`)

- INSERT, UPDATE, DELETE, REPLACE, MERGE (data write)
- CREATE, ALTER, DROP, TRUNCATE, RENAME (DDL)
- GRANT, REVOKE, SET (admin)
- Multi-statement (`;` separator — injection vector)

### ❌ TIDAK BOLEH (semua mode)

- Query database workspace lain (DB name di-derive server-side)
- Akses DB lain di server yang sama

### Env vars DB yang tersedia di workspace

```
DB_HOST        DB_USER        DB_PASSWORD
DATABASE_NAME  DATABASE_URL
```

Database name format: `<username>_<workspace_slug>`

---

## 7. Checkpoint System

| Aspek | Detail |
|---|---|
| **Auto-checkpoint** | Dibuat **sekali di awal sesi** sebelum iterasi pertama, label: `"Auto: sebelum sesi AI"` |
| **Eksplisit** | `workspace:checkpoint message="..."` |
| **Yang di-snapshot** | Seluruh workspace **kecuali**: `node_modules/`, `.git/`, `cache/`, `venv/`, `build/`, `dist/`, `.next/`, `target/` |
| **Format** | tar.gz, metadata di SQLite |
| **Limit** | **20 checkpoint per workspace** (yang lama auto-dihapus) |
| **Restore** | Stop runtime → backup pre-restore → wipe → untar snapshot |
| **Gagal** | Non-fatal — sesi tetap lanjut tanpa checkpoint |

---

## 8. Rate Limiting

| Jenis | Burst | Refill | Keterangan |
|---|---|---|---|
| API umum | 120 req | +2/detik | Endpoint umum |
| **AI chat** | **30 burst** | **+1 tiap 5 detik** | Paling ketat |
| File write | 120 req | +20/detik | Upload/write file |
| Login | 10 req | +1 tiap 10 detik | Brute-force protection |

Semua keyed per **IP address**. Backend bisa di-swap ke Redis via `setRateLimitBackend()`.

---

## 9. Memory System

```
AI emit memory:save
      │
      ▼
POST /api/ai/memory/compact
  ├─ Baca memory lama (.premdev-data/memory.md)
  ├─ Panggil LLM untuk merge + deduplicate
  │    ├─ Max input note : 4.000 char
  │    ├─ Max output      : 2.048 token, max 80 baris
  │    └─ Timeout         : 30 detik
  ├─ Tulis hasil ke .premdev-data/memory.md
  └─ Fallback: raw append jika compact gagal

Diload ke prompt berikutnya: max 6 KiB
```

---

## 10. Action Risk & Badge Visual

| Level | Badge | Contoh action |
|---|---|---|
| `high` | 🔴 ⚠ Berisiko | `delete`, bash `rm -rf`/`dd`/pipe-to-shell, SQL `DROP`/`DELETE`/`UPDATE`/`TRUNCATE`, `setEnv` key sensitif (AWS_, TOKEN, DB_HOST, dll) |
| `medium` | 🟡 ⚡ Side-effect | `setEnv` non-sensitif, `setRun`, `restart` |
| `low` | *(tidak ada badge)* | Baca file, `bash:run` biasa, `search`, `db:query` SELECT, dll |

Badge ditampilkan di ActionCard — **tidak memblokir eksekusi**, hanya informatif.

---

## 11. Docker Container Limits

| Container | PidsLimit | nproc (soft/hard) | nofile (soft/hard) | Memory |
|---|---|---|---|---|
| **Run** (`pw_*`) | **1.024** | 1.024 / 2.048 | 4.096 / 8.192 | per plan |
| **Shell** (`pwsh_*`) | 512 | 512 / 1.024 | 4.096 / 8.192 | 1 GiB |
| **Ephemeral exec** (`pwx_*`) | 512 | 512 / 1.024 | 4.096 / 8.192 | 1 GiB |

> Docker exec stream di-**demux** dengan `docker.modem.demuxStream()` — output bersih tanpa header bytes.

---

## 12. Security Summary

| Lapisan | Mekanisme |
|---|---|
| **Auth** | Setiap workspace route cek authenticated user + ownership |
| **Filesystem** | Path traversal reject + symlink mutation reject |
| **Shell** | Bash bebas — limit 4K char input & 120s timeout (behavioral, bukan whitelist) |
| **Database** | DB name server-derived; autonomous mode read-only via `checkSqlReadOnly()` |
| **Rate limit** | Per-IP, AI paling ketat (30 burst, 1 req/5 detik); swappable ke Redis |
| **Config** | `.premdev` tidak bisa di-overwrite langsung (blokir di parser) |
| **Jobs** | Buffer in-memory, GC setelah 1 jam; server restart → jobs aktif hilang |

---

## 13. ⚠️ Gap & Kelemahan Saat Ini

| # | Gap | Risiko |
|---|---|---|
| 1 | **Bash tidak di-sandbox kernel** | AI bisa jalankan network call, baca env vars, dll |
| 2 | **Max iterasi hanya di localStorage** | Tidak ada server-side cap; user bisa set sangat tinggi |
| 3 | **Job buffer in-memory** | Server restart di tengah sesi → job dan streaming hilang |
| 4 | **Auto-checkpoint gagal silently** | Sesi lanjut tanpa checkpoint, data tidak aman |
| 5 | **Memory compact pakai LLM extra** | Jika provider down saat `memory:save`, fallback ke raw append |
| 6 | **BM25 index tidak update** | File yang diubah saat sesi tidak masuk semantic search sampai session berikutnya |
| 7 | **AI re-read file yang sudah di-context** | Token terbuang untuk baca ulang file yang sudah dikirim |

---

## 14. Golden Rules yang Diinjeksi ke AI

1. **ACT, DON'T ANNOUNCE** — Langsung emit action block, tanpa "Saya akan baca..."
2. **Zero prose sebelum action block** — Maksimal 1 kalimat, langsung action
3. **NEVER self-narrate** — Tidak menulis tentang proses internal
4. **Summary 2-3 baris setelah selesai** — Fokus ke hasil, bukan proses
5. **NEVER minta user paste file** — Selalu baca sendiri via `bash:run cat <path>`

---

## 15. 🚀 Rules Baru di System Prompt (untuk Full-App Build yang Reliable)

Rules berikut sudah ditambahkan ke `AUTO_PILOT_PROMPT` di `apps/api/src/lib/ai-prompt.ts`.

### A. Verifikasi Koneksi DB Sebelum Nulis Kode DB

Sebelum menulis kode PHP/Python/Node yang query database, AI **wajib** verifikasi koneksi dulu:

```bash
mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DATABASE_NAME" -e "SHOW TABLES;" 2>&1 | head -5
```

Jika gagal → AI stop dan minta user isi Secrets panel. Tidak ada kode DB yang ditulis kalau koneksi diketahui broken.

### B. Syntax Check Setelah Tulis File (Wajib, Paralel)

Setiap file PHP/Python/JS yang ditulis langsung di-validate syntax-nya di batch yang sama (tidak ada tambahan latency):

| Stack | Command |
|---|---|
| PHP | `php -l <file> 2>&1` |
| Python | `python3 -m py_compile <file> 2>&1 && echo OK` |
| Node/JS | `node --check <file> 2>&1 && echo OK` |

Jika syntax error → fix sebelum `workspace:restart`. Crash-on-startup jauh lebih susah di-debug dari parse error yang langsung kelihatan.

### C. Install Deps di Run Command, Bukan bash:run

Kalau project punya `requirements.txt` atau `package.json` non-global:

```
✅ workspace:setRun  pip install -q -r requirements.txt && python3 app.py
❌ bash:run pip install flask   ← hilang kalau container restart
```

Deps yang di-prepend ke run command survive restart dan checkpoint restore.

### D. Error Budget — Aturan 3 Strikes

Kalau error message yang sama (80 char pertama) muncul di **3 batch berturut-turut** meski sudah dicoba berbeda cara:
1. AI **STOP** loop sekarang
2. Emit diagnostic: error exact + apa yang sudah dicoba + apa yang harus user cek manual
3. User fix root cause, lalu restart sesi

Tidak boleh looping terus — buang token dan bikin frustrasi.

### E. Full-App Build Protocol (7 Fase)

Untuk request "buat aplikasi [X]" yang melibatkan 5+ file:

| Fase | Aksi |
|---|---|
| **1. Orient** | `bash:run cat .premdev 2>/dev/null; ls -la; cat package.json 2>/dev/null` — kenali stack & entry point |
| **2. Plan** | Emit `plan:` block — list SEMUA file yang akan dibuat |
| **3. Scaffold** | Buat SEMUA file stub sekaligus — tiap href di navigasi HARUS ada file-nya |
| **4. Implement** | Isi content file per file. Tiap file → syntax check (paralel). Tiap 5 file → checkpoint |
| **5. DB Schema** | `db:query CREATE TABLE …` → verify `db:query SHOW TABLES;` |
| **6. Run & Verify** | `workspace:setRun` + `workspace:restart` + `curl` semua halaman utama |
| **7. Done** | 3-baris summary, stop — tidak tanya "ada yang mau ditambah?" |

---

## 16. 💡 Saran Perbaikan Selanjutnya (Butuh Code Change)

Ini adalah fitur-fitur yang belum ada di codebase tapi akan membuat agent jauh lebih reliable untuk membangun full app:

### 1. Auto-Syntax-Check Endpoint (Impact: Tinggi)

**Masalah**: Sekarang AI harus manually emit `bash:run php -l` setelah setiap file write. Kalau lupa, server crash dan AI harus debug dari awal.

**Solusi**: Endpoint baru `POST /workspaces/:id/syntax-check` yang auto-jalan setelah setiap `file:` action dari orchestrator. Tidak perlu AI emit — orchestrator inject otomatis.

```typescript
// Endpoint baru di workspaces.ts
app.post("/:id/syntax-check", async (req, reply) => {
  const { path } = req.body;
  const ext = path.split('.').pop();
  const cmd = ext === 'php' ? `php -l ${path}` :
               ext === 'py'  ? `python3 -m py_compile ${path} && echo OK` :
               ext === 'js'  ? `node --check ${path} && echo OK` : null;
  if (!cmd) return { ok: true, skipped: true };
  const r = await runOneOff(workspaceId, cmd, 10_000);
  return { ok: r.exitCode === 0, output: r.output };
});
```

Orchestrator: setelah `file:` action sukses, auto-inject `syntax-check` action dan tampilkan hasilnya. Kalau syntax error → AI dikasih tahu sebelum restart.

### 2. Session Pre-Flight Orientation (Impact: Tinggi)

**Masalah**: AI sering "buta" di awal sesi — tidak tahu stack yang sedang jalan, apakah server hidup, port berapa, package manager apa. Hasilnya: langsung tulis kode tanpa orientasi → salah stack, salah command.

**Solusi**: Di awal setiap sesi autonomous (sebelum turn pertama), orchestrator otomatis jalankan script orientasi dan inject hasilnya ke system context:

```bash
echo "=STACK="; cat .premdev 2>/dev/null || echo "(no .premdev)";
echo "=FILES="; ls -la | head -30;
echo "=PROCESS="; ps aux | grep -E 'php|node|python|ruby|go' | grep -v grep | head -5;
echo "=PORT="; cat .premdev 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('port','not set'))" 2>/dev/null;
echo "=MEMORY="; cat .premdev-data/memory.md 2>/dev/null | head -30
```

Output diinjeksi sebagai "Workspace Pre-Flight" block di system prompt. AI langsung tau konteks tanpa harus emit orient batch sendiri.

### 3. Nav Link Integrity Auto-Check (Impact: Sedang)

**Masalah**: AI sering buat `index.php` dengan nav ke `berita.php`, `galeri.php`, dll tapi lupa create file-nya. User klik link → 404.

**Solusi**: Setelah setiap `file:` action yang menulis HTML/PHP, orchestrator extract semua `href="*.php"` dan `href="*.html"` dari output file, lalu check apakah tiap target ada di workspace. Kalau ada yang missing → auto-inject warning ke tool result:

```
⚠ Nav link check: href="galeri.php" → FILE NOT FOUND di workspace.
  Buat file ini sekarang atau hapus link dari nav.
```

AI langsung fix di iterasi berikutnya, tidak perlu user report.

---

*Terakhir diperbarui: 26 Agustus 2026*
