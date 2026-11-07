#!/bin/sh
set -eu

if [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "REDIS_PASSWORD is required. Set it in Fly secrets." >&2
  exit 1
fi

config_file=/tmp/vent-redis.conf

# Keep the password file private.
umask 077
cat > "$config_file" <<EOF
bind 0.0.0.0 ::
protected-mode yes
requirepass $REDIS_PASSWORD

dir /data
appendonly yes
appendfsync everysec

maxmemory 128mb
maxmemory-policy noeviction
EOF

chown redis:redis /data "$config_file"

# Let Redis receive shutdown signals directly.
exec su-exec redis redis-server "$config_file"
