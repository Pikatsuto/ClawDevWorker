#!/bin/sh
set -e

CONFIG_DIR="/etc/searxng"
DEFAULT_DIR="/etc/default/searxng"

# Initialiser settings.yml depuis les defaults si absent dans le volume
if [ ! -f "${CONFIG_DIR}/settings.yml" ]; then
    echo "[searxng] Premier démarrage — copie de la config par défaut"
    cp "${DEFAULT_DIR}/settings.yml" "${CONFIG_DIR}/settings.yml"
fi

exec "$@"
