#!/bin/bash
# Auto-push ke GitHub setiap kali dijalankan
# Dipanggil otomatis oleh runner.py saat startup

GH_TOKEN="${GH_TOKEN:-}"
GH_REPO="${GH_REPO:-}"

if [ -z "$GH_TOKEN" ] || [ -z "$GH_REPO" ]; then
    echo "[github_sync] SKIP: GH_TOKEN atau GH_REPO belum diset"
    exit 0
fi

# Bentuk URL dengan token
REPO_URL="https://${GH_TOKEN}@${GH_REPO}"

# Hapus lock file yang tersisa kalau ada
rm -f .git/config.lock .git/index.lock .git/HEAD.lock 2>/dev/null || true

# Setup git identity
git config user.email "replit-bot@auto-sync.local" 2>/dev/null || true
git config user.name "Replit Auto Sync" 2>/dev/null || true

# Set remote
if git remote get-url github-auto &>/dev/null; then
    git remote set-url github-auto "$REPO_URL"
else
    git remote add github-auto "$REPO_URL"
fi

# Untrack folder & file yang seharusnya diabaikan (kalau masih ter-track git)
UNTRACK_LIST=(
    "attached_assets"
    "backup_db"
    "logs"
)
for item in "${UNTRACK_LIST[@]}"; do
    if git ls-files --error-unmatch "$item" &>/dev/null 2>&1 || git ls-files "$item" | grep -q .; then
        echo "[github_sync] Untrack: $item"
        git rm -r --cached "$item" 2>/dev/null || true
    fi
done

# Untrack semua file .zip yang ter-track
TRACKED_ZIPS=$(git ls-files "*.zip" 2>/dev/null)
if [ -n "$TRACKED_ZIPS" ]; then
    echo "[github_sync] Untrack zip files..."
    git rm --cached *.zip 2>/dev/null || true
fi

# Untrack semua file .db yang ter-track
TRACKED_DBS=$(git ls-files "*.db" 2>/dev/null)
if [ -n "$TRACKED_DBS" ]; then
    echo "[github_sync] Untrack db files..."
    git rm --cached *.db 2>/dev/null || true
fi

# Tambah semua perubahan
git add -A

# Cek apakah ada perubahan baru
if git diff --cached --quiet; then
    echo "[github_sync] Tidak ada perubahan baru, skip commit."
else
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

    # Buat pesan commit yang deskriptif dari file yang berubah
    ADDED=$(git diff --cached --name-only --diff-filter=A 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
    MODIFIED=$(git diff --cached --name-only --diff-filter=M 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')
    DELETED=$(git diff --cached --name-only --diff-filter=D 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')

    MSG_PARTS=()
    [ -n "$ADDED" ]    && MSG_PARTS+=("tambah: $ADDED")
    [ -n "$MODIFIED" ] && MSG_PARTS+=("ubah: $MODIFIED")
    [ -n "$DELETED" ]  && MSG_PARTS+=("hapus: $DELETED")

    # Gabung jadi satu baris, batasi 120 karakter
    DETAIL=$(IFS='; '; echo "${MSG_PARTS[*]}")
    DETAIL="${DETAIL:0:120}"

    COMMIT_MSG="update ${TIMESTAMP}: ${DETAIL}"

    git commit -m "$COMMIT_MSG" && echo "[github_sync] Commit: ${COMMIT_MSG}"
fi

# Push ke GitHub
echo "[github_sync] Push ke GitHub..."
if git push github-auto HEAD:main --force 2>&1; then
    echo "[github_sync] Push berhasil!"
else
    echo "[github_sync] Push gagal (cek GH_TOKEN / GH_REPO)"
fi
