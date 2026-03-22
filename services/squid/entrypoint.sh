#!/bin/sh
set -e

CONFIG_DIR="/etc/squid"
DEFAULT_DIR="/etc/default/squid"
WHITELIST_DIR="/etc/squid/whitelist"

# Initialize squid.conf from defaults if missing in volume
if [ ! -f "${CONFIG_DIR}/squid.conf" ]; then
    echo "[squid] First startup — copying default config"
    cp "${DEFAULT_DIR}/squid.conf" "${CONFIG_DIR}/squid.conf"
fi

# Initialize the whitelist directory shared with openclaw-agent
if [ ! -d "${WHITELIST_DIR}" ]; then
    echo "[squid] Creating whitelist directory"
    mkdir -p "${WHITELIST_DIR}"
fi

if [ ! -f "${WHITELIST_DIR}/whitelist.conf" ]; then
    echo "[squid] Creating empty whitelist"
    touch "${WHITELIST_DIR}/whitelist.conf"
fi

# Initialize cache if needed
if [ ! -d "/var/spool/squid/00" ]; then
    echo "[squid] Initializing cache"
    squid -z --foreground 2>/dev/null || true
fi

exec "$@"
