###############################################################################
# ollama-init — Ephemeral model download service
#
# ATOMIC: pull-models.sh is baked into the image, no bind mount required.
# restart: "no" — runs once on first docker compose up.
# Subsequent runs are near-instant (already present models detected).
###############################################################################

FROM alpine:3.19

# Dependencies: curl for Ollama + HuggingFace API calls, bash for the script
RUN apk add --no-cache bash curl jq

# Script baked into the image — never bind mounted
COPY scripts/pull-models.sh /pull-models.sh
RUN chmod +x /pull-models.sh

ENTRYPOINT ["/bin/bash", "/pull-models.sh"]
