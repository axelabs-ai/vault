# vault-cron — Docker supercronic cron service (L2+L3 uplift)
#
# Absorbs the prior host LaunchAgents (com.realchoice.vault-backup,
# vault-health) into a container that runs supercronic.
#
# Builds on alpine for size. Includes:
#   - supercronic (cron-in-container, used by ~/stream too)
#   - docker CLI  (to call `docker exec vault-app` for backup snapshots
#                  via the mounted /var/run/docker.sock — see security note
#                  in ~/vault/README.md)
#   - gnupg       (encrypt backup tar with public key only — private key
#                  stays on host outside this container)
#   - rclone      (optional Backblaze B2 sync; skips cleanly if no remote)
#   - curl, jq, bash, tzdata
#
# All scripts under /app/scripts/ are container-native rewrites of the
# host versions; the host scripts remain in ~/vault/scripts/ as legacy
# fallback documented in README.

FROM alpine:3.20

ARG TARGETARCH=arm64
ARG SUPERCRONIC_VERSION=v0.2.45

# --- packages --------------------------------------------------------------
RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        docker-cli \
        gnupg \
        jq \
        rclone \
        sqlite \
        tzdata \
    && cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
    && echo "Asia/Seoul" > /etc/timezone

# --- supercronic -----------------------------------------------------------
RUN curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
        -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic \
    && /usr/local/bin/supercronic -version

# --- layout ----------------------------------------------------------------
WORKDIR /app
COPY scripts/      /app/scripts/
COPY crontab       /app/crontab
COPY keys/         /app/keys/

RUN chmod +x /app/scripts/*.sh \
    && mkdir -p /backups /logs /vault-data \
    && mkdir -p /root/.gnupg && chmod 700 /root/.gnupg

# Trust model = always: backup encryption uses a public key we manage —
# no web-of-trust signature needed for our local use.
RUN printf "trust-model always\nkeyserver hkps://keys.openpgp.org\n" > /root/.gnupg/gpg.conf

ENV PATH=/app/scripts:$PATH \
    VAULT_CONTAINER=vault-app \
    VAULT_CADDY=vault-caddy \
    VAULT_GPG_RECIPIENT=vault-backup@realchoice.co.kr \
    VAULT_BACKUP_DIR=/backups \
    VAULT_LOG_DIR=/logs \
    VAULT_BACKUP_RETAIN_DAYS=30 \
    VAULT_HEALTH_LOG_RETAIN_DAYS=7 \
    TZ=Asia/Seoul

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["supercronic", "-overlapping", "/app/crontab"]
