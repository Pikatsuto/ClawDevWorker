FROM ubuntu/squid:latest

COPY services/squid/squid.conf /etc/default/squid/squid.conf

COPY services/squid/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["squid", "-NYCd", "1"]
