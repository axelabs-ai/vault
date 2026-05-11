#!/bin/bash
# vault 백업 전용 GPG 키 페어 생성 (백업 암호화용)
# 사용자 직접 실행: passphrase 결정이 본인 master password 정책과 묶임.
# - 공개키: ~/vault/vault-backup.pub.asc 로 export (commit 가능, backup.sh 사용)
# - 개인키: 종이 출력 → 가정 내화 금고 + Cryptosteel 2-of-3 분산 (§5.2)

set -euo pipefail

NAME="vault-backup"
EMAIL="${VAULT_GPG_RECIPIENT:-vault-backup@realchoice.co.kr}"
COMMENT="Vaultwarden backup encryption — realchoice.co.kr"

if gpg --list-keys "$EMAIL" >/dev/null 2>&1; then
  echo "[gpg-init] key already exists for $EMAIL"
  gpg --list-keys "$EMAIL"
  exit 0
fi

echo "[gpg-init] generating ed25519/cv25519 keypair for $EMAIL"
echo "[gpg-init] gpg will prompt for passphrase — choose strong, record later in vault"
echo

# Interactive: gpg prompts for passphrase via pinentry/agent.
# Subkey: cv25519 encrypt (backup.sh uses public half).
gpg --quick-generate-key "$NAME ($COMMENT) <$EMAIL>" ed25519 sign 0
FPR=$(gpg --list-keys --with-colons "$EMAIL" | awk -F: '/^fpr:/ {print $10; exit}')
gpg --quick-add-key "$FPR" cv25519 encr 0

echo
echo "[gpg-init] export public key -> ~/vault/vault-backup.pub.asc"
gpg --armor --export "$EMAIL" > ~/vault/vault-backup.pub.asc
chmod 644 ~/vault/vault-backup.pub.asc

echo "[gpg-init] fingerprint: $FPR"
echo

cat <<MSG
[gpg-init] DONE.
  Public key  : ~/vault/vault-backup.pub.asc (safe to commit)
  Private key : ~/.gnupg/ (NEVER commit, FileVault-protected)
  Fingerprint : $FPR

  NEXT (manual):
    1) Paper-export private key for offline backup (run when ready):
       gpg --armor --export-secret-keys $EMAIL > /tmp/vault-backup.priv.asc
       lpr /tmp/vault-backup.priv.asc        # print
       shred -u /tmp/vault-backup.priv.asc
       → home safe + bank safe (2-of-3, §5.2)
    2) Cryptosteel/Billfodl metal backup of paper key (optional, fire/water-proof).
    3) Record GPG passphrase as new vault entry once Vaultwarden is up.
    4) Quarterly: 'gpg --list-secret-keys' to confirm fingerprint unchanged.
MSG
