###############################################################################
# ollama-init — Service éphémère de téléchargement des modèles
#
# ATOMIC : pull-models.sh est baked dans l'image, aucun bind mount requis.
# restart: "no" — s'exécute une seule fois au premier docker compose up.
# Les runs suivants sont quasi-instantanés (modèles déjà présents détectés).
###############################################################################

FROM alpine:3.19

# Dépendances : curl pour les appels API Ollama + HuggingFace, bash pour le script
RUN apk add --no-cache bash curl jq

# Script baked dans l'image — jamais monté en bind mount
COPY scripts/pull-models.sh /pull-models.sh
RUN chmod +x /pull-models.sh

ENTRYPOINT ["/bin/bash", "/pull-models.sh"]
