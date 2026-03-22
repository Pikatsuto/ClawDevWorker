FROM searxng/searxng:latest

# Config par défaut embarquée dans l'image
COPY settings.yml /etc/default/searxng/settings.yml

# Entrypoint — initialise /etc/searxng au premier démarrage du volume
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/local/searxng/manage", "run"]
