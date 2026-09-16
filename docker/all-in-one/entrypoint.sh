#!/bin/sh
set -eu

if [ "$#" -gt 0 ]; then
    exec /usr/local/bin/mindleak-light "$@"
fi

export LC_ALL=C
MINDLEAK_HTTP_TOKEN=${MINDLEAK_HTTP_TOKEN:-}
if [ "${#MINDLEAK_HTTP_TOKEN}" -lt 32 ]; then
    printf '%s\n' 'Set MINDLEAK_HTTP_TOKEN to at least 32 non-whitespace ASCII characters.' >&2
    exit 64
fi
case "$MINDLEAK_HTTP_TOKEN" in
    *[![:graph:]]*)
        printf '%s\n' 'MINDLEAK_HTTP_TOKEN must contain only non-whitespace ASCII characters.' >&2
        exit 64
        ;;
esac

POSTGRES_DB=${POSTGRES_DB:-mindleak_light}
case "$POSTGRES_DB" in
    ''|*[!a-zA-Z0-9_]*)
        printf '%s\n' 'POSTGRES_DB must contain only letters, digits, and underscores.' >&2
        exit 64
        ;;
esac
if [ "${#POSTGRES_DB}" -gt 63 ] || [ "${POSTGRES_USER:-mindleak_light}" != mindleak_light ]; then
    printf '%s\n' 'The managed database requires POSTGRES_USER=mindleak_light and a database name of at most 63 characters.' >&2
    exit 64
fi
if [ -n "${MINDLEAK_DATABASE_URL:-}" ]; then
    printf '%s\n' 'The all-in-one image manages its database internally. Use the app target for an external MINDLEAK_DATABASE_URL.' >&2
    exit 64
fi

export MINDLEAK_HTTP_TOKEN POSTGRES_USER=mindleak_light POSTGRES_DB POSTGRES_HOST_AUTH_METHOD=trust
export MINDLEAK_DATABASE_URL="host=/var/run/postgresql user=mindleak_light dbname=$POSTGRES_DB sslmode=disable"
exec /usr/bin/supervisord --nodaemon --configuration /etc/supervisor/mindleak.conf
