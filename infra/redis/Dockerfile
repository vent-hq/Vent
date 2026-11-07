FROM redis:7.4-alpine

COPY start.sh /usr/local/bin/start-vent-redis
RUN apk add --no-cache su-exec && chmod +x /usr/local/bin/start-vent-redis
CMD ["/usr/local/bin/start-vent-redis"]
