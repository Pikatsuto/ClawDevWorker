FROM searxng/searxng:latest

# Default config embedded in the image
COPY services/searxng/settings.yml /etc/default/searxng/settings.yml

# Entrypoint — initializes /etc/searxng on first volume startup
COPY services/searxng/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/local/searxng/manage", "run"]
