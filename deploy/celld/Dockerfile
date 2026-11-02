# syntax=docker/dockerfile:1
ARG CELLD_IMAGE=ghcr.io/denoland/celld:v0.6.3@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc
FROM ${CELLD_IMAGE} AS celld

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Copy explicit paths so .dev.vars, .env and local Worker state never enter a layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY deploy/celld/package.json deploy/celld/package-lock.json ./deploy/celld/
RUN npm ci --prefix deploy/celld --ignore-scripts --no-audit --no-fund
COPY wrangler.jsonc ./
COPY src ./src
COPY public ./public
COPY deploy/celld/build.mjs ./deploy/celld/
RUN node deploy/celld/build.mjs

FROM node:24-bookworm-slim AS runtime
RUN groupadd --gid 10001 relay && useradd --uid 10001 --gid relay --no-create-home relay \
    && mkdir -p /app/deploy/celld /var/lib/celld && chown relay:relay /var/lib/celld
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld /usr/share/doc/celld /usr/share/doc/celld
COPY --from=build /app/bundle /app/bundle
COPY deploy/celld/entrypoint.sh deploy/celld/publish.mjs /app/deploy/celld/
RUN chmod 755 /app/deploy/celld/entrypoint.sh
WORKDIR /app
USER 10001:10001
ENV CELLD_STATE_DIR=/var/lib/celld CELLD_DURABILITY=bucket
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/deploy/celld/entrypoint.sh"]
CMD ["serve"]
