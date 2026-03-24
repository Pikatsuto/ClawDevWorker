#!/bin/sh
# auto-install-docs.sh — Called by the orchestrator when mcp-docs detects a missing doc
# Usage: docker compose exec devdocs thor docs:download <slug>
# This script is meant to be called from outside the devdocs container
SLUG="$1"
[ -z "$SLUG" ] && echo "Usage: auto-install-docs.sh <slug>" && exit 1
echo "[auto-install-docs] Downloading $SLUG..."
docker exec devdocs thor docs:download "$SLUG" 2>&1
echo "[auto-install-docs] Done: $SLUG"
