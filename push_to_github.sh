#!/bin/bash
# push_to_github.sh
# Jalankan dari Git Bash: bash push_to_github.sh
# Atau dari terminal VPS / Linux: bash push_to_github.sh

# Baca .env jika ada
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
fi

GH_TOKEN="${GH_TOKEN:-}"
GH_REPO="${GH_REPO:-}"

if [ -z "$GH_TOKEN" ] || [ -z "$GH_REPO" ]; then
    echo "❌ ERROR: GH_TOKEN atau GH_REPO belum diset di file .env"
    echo "   Pastikan .env berisi:"
    echo "   GH_TOKEN=ghp_xxxxxxxxxxxx"
    echo "   GH_REPO=github.com/USERNAME/premdev.git"
    exit 1
fi

REPO_URL="https://${GH_TOKEN}@${GH_REPO}"

# Inisialisasi git repository jika belum ada
if [ ! -d ".git" ]; then
    echo "📁 Menginisialisasi git repository lokal..."
    git init
    git branch -M main
fi

# Setup git identity
git config user.email "premdev-bot@auto-sync.local" 2>/dev/null || true
git config user.name "PremDev Sync" 2>/dev/null || true

# Set remote github-auto
if git remote get-url github-auto &>/dev/null; then
    git remote set-url github-auto "$REPO_URL"
else
    git remote add github-auto "$REPO_URL"
fi

# Test koneksi ke GitHub terlebih dahulu
echo "🔍 Test koneksi ke GitHub..."
if git ls-remote github-auto HEAD &>/dev/null; then
    echo "✅ Koneksi GitHub berhasil!"
else
    echo "❌ Gagal koneksi ke GitHub. Periksa GH_TOKEN dan GH_REPO di .env"
    exit 1
fi

# Stage semua perubahan
git add -A

# Cek ada perubahan?
if git diff --cached --quiet; then
    echo "ℹ️  Tidak ada perubahan baru."
else
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    ADDED=$(git diff --cached --name-only --diff-filter=A 2>/dev/null | head -5 | tr '\n' ',' | sed 's/,$//')
    MODIFIED=$(git diff --cached --name-only --diff-filter=M 2>/dev/null | head -5 | tr '\n' ',' | sed 's/,$//')
    MSG_PARTS=()
    [ -n "$ADDED" ]    && MSG_PARTS+=("tambah: $ADDED")
    [ -n "$MODIFIED" ] && MSG_PARTS+=("ubah: $MODIFIED")
    DETAIL=$(IFS='; '; echo "${MSG_PARTS[*]}")
    COMMIT_MSG="feat(9router): ${TIMESTAMP} — ${DETAIL:0:100}"
    git commit -m "$COMMIT_MSG"
    echo "📝 Commit: $COMMIT_MSG"
fi

# Push ke GitHub
echo "🚀 Push ke GitHub..."
if git push github-auto HEAD:main --force 2>&1; then
    echo "✅ Push berhasil! Buka: https://${GH_REPO%.git}"
else
    echo "❌ Push gagal. Periksa token dan nama repo."
    exit 1
fi
