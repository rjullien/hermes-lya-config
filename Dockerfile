# Image custom Hermes Lya — image officielle + outils agents (slim)
# Pattern: rjullien/hermes-leo-config, sans Go ni Devin CLI
#
# Outils ajoutés (tous absents de l'image officielle hermes-agent) :
#   - gws      : Google Workspace CLI (Gmail, Tasks, Calendar, Drive) — remplace gws-axi 0.6.1 ET himalaya
#   - gh       : GitHub CLI (issues, PRs, releases)
#   - kubectl  : debug cluster (lecture pods/logs)
#
# Base: image officielle hermes-agent (debian:13.4, glibc → binaires gnu, PAS musl)
#
# ⚠️ SÉCURITÉ : repo PUBLIC + image ghcr.io publique — AUCUN secret/token dans ce Dockerfile.
# Les credentials (gws OAuth, etc.) vont dans Infisical ou sur le PVC, jamais gravés ici.

# Base épinglée par digest (S-02) : reconstruire ce commit utilise toujours la
# même image, même si le tag v2026.8.16 est déplacé. Renovate maintient le
# couple tag+digest (pinDigests).
#
# ⚠️ ARCHITECTURE (P-03) : image linux/amd64 UNIQUEMENT. Les URLs ci-dessous
# ciblent x86_64/amd64 et build.yml ne construit que linux/amd64. Pour arm64,
# paramétrer via TARGETARCH et valider les 3 binaires (voir README §Architecture).
FROM nousresearch/hermes-agent:v2026.9.11@sha256:9469b3e78b9545b6d576eb8887a95352e9a0ea83730eaf31431cf862ca1010e1

# Ordre des couches (P-02) : chaque couple `# renovate` + ARG version + ARG
# SHA256 est placé JUSTE avant le RUN qui l'utilise, du plus léger au plus lourd
# (gws → gh → kubectl). Ainsi, changer la version d'un outil n'invalide QUE sa
# couche et les suivantes, pas les précédentes.
# Chaque outil a un SHA-256 attendu (S-01) : téléchargement vérifié AVANT
# extraction. Renovate maintient version + digest (voir renovate.json).
USER root

# Correctifs Debian (porte Trivy CRITICAL) : l'image de base est digests-épinglée
# et peut donc rester en retard sur les DSA/security de trixie. Sans cette
# couche, la CI échoue sur des CRITICAL OS « Status: fixed » (glib, mbedtls,
# perl…) alors que `apt` peut les appliquer ici. On ne les met PAS dans
# `.trivyignore` — la porte doit rester capable d'échouer sur une régression
# introduite par ce dépôt. Reliquats vraiment non patchables via apt → S-03.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# --- gws : Google Workspace CLI (glibc/debian, pas de -musl) ---
# Remplace himalaya pour tout le Gmail automatisé (API native, OAuth standard)
# Télécharge dans un fichier temporaire, vérifie le SHA-256, PUIS extrait.
# renovate: datasource=github-releases depName=googleworkspace/cli
ARG GWS_VERSION=0.22.5
ARG GWS_SHA256=de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f
RUN curl -fsSL -o /tmp/gws.tar.gz https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz \
    && echo "${GWS_SHA256}  /tmp/gws.tar.gz" | sha256sum -c - \
    && tar xz -C /usr/local/bin --strip-components=0 -f /tmp/gws.tar.gz ./gws \
    && rm -f /tmp/gws.tar.gz \
    && chmod +x /usr/local/bin/gws

# --- gh : GitHub CLI ---
# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.101.0
ARG GH_SHA256=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8
RUN curl -fsSL -o /tmp/gh.tar.gz https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar xz -C /tmp -f /tmp/gh.tar.gz \
    && cp /tmp/gh_${GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh_${GH_VERSION}_linux_amd64 /tmp/gh.tar.gz \
    && chmod +x /usr/local/bin/gh

# --- kubectl : debug cluster ---
# renovate: datasource=github-tags depName=kubernetes/kubernetes
ARG KUBECTL_VERSION=1.37.0
ARG KUBECTL_SHA256=6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f
RUN curl -fsSL -o /tmp/kubectl https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl \
    && echo "${KUBECTL_SHA256}  /tmp/kubectl" | sha256sum -c - \
    && install -m 0755 /tmp/kubectl /usr/local/bin/kubectl \
    && rm -f /tmp/kubectl

# Les scripts/venvs/skills restent sur le PVC (/opt/data) et les ConfigMaps —
# l'image ne porte que les binaires système/tools.
