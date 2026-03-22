#!/bin/sh
set -e

CONFIG_DIR="/etc/squid"
DEFAULT_DIR="/etc/default/squid"
WHITELIST_DIR="/etc/squid/whitelist"

# Initialiser squid.conf depuis les defaults si absent dans le volume
if [ ! -f "${CONFIG_DIR}/squid.conf" ]; then
    echo "[squid] Premier démarrage — copie de la config par défaut"
    cp "${DEFAULT_DIR}/squid.conf" "${CONFIG_DIR}/squid.conf"
fi

# Initialiser le dossier whitelist partagé avec openclaw-agent
if [ ! -d "${WHITELIST_DIR}" ]; then
    echo "[squid] Création du dossier whitelist"
    mkdir -p "${WHITELIST_DIR}"
fi

if [ ! -f "${WHITELIST_DIR}/whitelist.conf" ]; then
    echo "[squid] Création de la whitelist vide"
    touch "${WHITELIST_DIR}/whitelist.conf"
fi

# Initialiser le cache si nécessaire
if [ ! -d "/var/spool/squid/00" ]; then
    echo "[squid] Initialisation du cache"
    squid -z --foreground 2>/dev/null || true
fi

exec "$@"
