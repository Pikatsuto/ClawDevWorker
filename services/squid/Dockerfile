FROM alpine:3.21

RUN apk add --no-cache squid

COPY services/squid/squid.conf /etc/default/squid/squid.conf
COPY --chmod=755 services/squid/entrypoint.sh /usr/local/bin/entrypoint

ENTRYPOINT ["entrypoint"]