FROM ubuntu/squid:latest

COPY squid.conf /etc/default/squid/squid.conf

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["squid", "-NYCd", "1"]
