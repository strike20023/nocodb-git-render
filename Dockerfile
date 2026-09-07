ARG NOCODB_IMAGE=nocodb/nocodb:latest
FROM ${NOCODB_IMAGE}

USER root

# The upstream image is Alpine today. The fallback keeps this derived image
# usable if NocoDB changes its base distribution later.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache git openssh-client sqlite ca-certificates; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        git openssh-client sqlite3 ca-certificates && \
      rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Unsupported NocoDB base image: apk or apt-get is required" >&2; \
      exit 1; \
    fi

COPY service/ /opt/nocodb-git/
RUN chmod 0755 /opt/nocodb-git/git-askpass.sh

# NocoDB stays private on 8080. The wrapper/proxy owns Render's public port.
ENV PORT=10000 \
    NOCODB_INTERNAL_PORT=8080 \
    GIT_INTERNAL_PORT=9000 \
    NC_APP_DATA_DIR=/var/lib/nocodb-live/ \
    NC_TOOL_DIR=/var/lib/nocodb-live/ \
    NC_WEBHOOK_ALLOW_PRIVATE_NETWORK=true \
    NC_ALLOW_LOCAL_HOOKS=true \
    GIT_BRANCH=main \
    GIT_REPO_DIR=/var/lib/nocodb-git/repository \
    GIT_AUTHOR_NAME="NocoDB Version Bot" \
    GIT_AUTHOR_EMAIL="nocodb-version-bot@users.noreply.github.com"

EXPOSE 10000


# Keep the upstream image's ENTRYPOINT (dumb-init) and replace only its CMD.
CMD ["node", "/opt/nocodb-git/server.js"]
