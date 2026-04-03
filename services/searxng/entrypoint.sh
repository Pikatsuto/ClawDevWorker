#!/bin/sh
set -e

CONFIG_DIR="/etc/searxng"
DEFAULT_DIR="/etc/default/searxng"

# Initialize settings.yml from defaults if missing in volume
if [ ! -f "${CONFIG_DIR}/settings.yml" ]; then
    echo "[searxng] First startup — copying default config"
    cp "${DEFAULT_DIR}/settings.yml" "${CONFIG_DIR}/settings.yml"
fi

exec /usr/local/searxng/entrypoint.sh
