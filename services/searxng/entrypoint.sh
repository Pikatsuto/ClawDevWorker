#!/bin/sh
set -e

CONFIG_DIR="/etc/searxng"
DEFAULT_DIR="/etc/default/searxng"

# Always sync settings from the image — volume may have stale config
echo "[searxng] Syncing settings.yml from image defaults"
cp "${DEFAULT_DIR}/settings.yml" "${CONFIG_DIR}/settings.yml"

exec /usr/local/searxng/entrypoint.sh
