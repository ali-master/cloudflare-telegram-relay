# Self-host Telegram Relay

Run the same application on your own infrastructure with celld. The image bundles
`src/index.ts` and `public/`, preserving the Worker name, Durable Object bindings,
and migrations from `wrangler.jsonc`. It connects directly to the Telegram API.
For Kubernetes, use the [Kubernetes deployment guide](kubernetes/README.md).

## Requirements

- Docker with Compose v2.
- An existing private S3-compatible bucket with conditional writes, ranged reads,
  and read-after-write consistency. Amazon S3 is a supported option. Check
  [celld's storage requirements](https://github.com/denoland/celld/blob/v0.6.3/docs/guarantees.md#what-the-bucket-must-provide)
  before selecting another provider.
- Bucket credentials with the required read, write, list, and delete access to
  this fleet's bucket/prefix.
- A public hostname and an HTTPS reverse proxy for Telegram webhooks.
- Outbound DNS and HTTPS access to your storage endpoint and `api.telegram.org`.

The deployment runs one celld node. Its named volume contains local state; the
bucket is the durable source of truth for data and queued work. No database or
message broker needs to be installed separately. Keep the bucket private: it
also contains deployment bindings, including the admin key.

## Deploy with Docker Compose

Run these commands from the repository root:

```sh
cd deploy/celld
cp .env.example .env
chmod 600 .env
mkdir -m 700 secrets
openssl rand -hex 32 > secrets/API_KEY
chmod 644 secrets/API_KEY
```

Save the generated key in your password manager. The `secrets/` directory stays
private on the host; the file is readable inside the non-root publishing
container. Compose file-backed secrets preserve host permissions, so a root-owned
`0600` file may be unreadable to the container's UID 10001. Neither `.env` nor
`secrets/` is committed or copied into the image.

Edit `.env` before continuing:

| Setting | Value |
| --- | --- |
| `CELLD_BUCKET` | Existing bucket and stable prefix, e.g. `s3://company-relay/production` |
| `AWS_REGION` | Bucket region, e.g. `eu-central-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credentials for this bucket/prefix |
| `AWS_SESSION_TOKEN` | Only for temporary credentials |
| `S3_ENDPOINT` | HTTPS endpoint for custom S3 providers; leave empty for Amazon S3 |
| `RELAY_IMAGE` | Local tag or your registry image reference |
| `RELAY_BIND_ADDRESS`, `RELAY_PORT` | Default `127.0.0.1:8080`, for a reverse proxy on the host |
| `CELLD_TRUST_FORWARDED_HEADERS` | `1` only after configuring the trusted HTTPS proxy below; otherwise `0` |

Do not put bot tokens in `.env`. Connect bots and create application keys in the
dashboard after deployment. `API_KEY` is read from the mounted file only when
publishing; it is not a runtime environment variable on the serving container.

Build, publish, then start the relay:

```sh
docker compose build
docker compose run --rm publish
docker compose up -d --wait --wait-timeout 360 relay
```

Publishing must succeed before the first start. It uploads the Worker bundle,
static assets and admin binding to your bucket. The publisher runs only when
explicitly invoked; restarting the serving container does not republish code or
rotate the key.

The local dashboard is at <http://127.0.0.1:8080>. Complete HTTPS setup before
registering Telegram webhooks, then open your public URL and log in with the
saved admin key. Follow [Connect your bots](../../README.md#connect-your-bots).

The default health check is `/.well-known/celld/health`, celld's readiness route.
The application's `/health` does not establish storage readiness. Recovery can
take a few minutes after an abrupt stop; the startup allowance is intentionally
longer than the roughly two-minute readiness delay observed during validation.

## Build an image for a registry

For Kubernetes or servers that pull prebuilt images, run from the repository root
with your registry path and an immutable release tag:

```sh
export RELAY_RELEASE_IMAGE=registry.example.com/your-team/telegram-relay:1.0.0
docker build -f deploy/celld/Dockerfile -t "$RELAY_RELEASE_IMAGE" .
docker push "$RELAY_RELEASE_IMAGE"
```

Build for the target node architecture. For a registry image covering both common
architectures, use an appropriately configured Buildx builder:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f deploy/celld/Dockerfile -t "$RELAY_RELEASE_IMAGE" --push .
```

Set the same registry reference in the Kubernetes overlay or Compose `RELAY_IMAGE`.
The Dockerfile pins the celld runtime by digest; the image build does not require
any storage credentials or admin key.

## HTTPS and client IPs

Use [nginx.conf.example](nginx.conf.example) with nginx on the Docker host. Replace
`relay.example.com` and the certificate paths, validate with `nginx -t`, then
reload nginx. The example forwards to `127.0.0.1:8080`; adjust that port if you
changed `RELAY_PORT`. Set `CELLD_TRUST_FORWARDED_HEADERS=1` and recreate the relay
container after the proxy is configured:

```sh
docker compose up -d --wait --wait-timeout 360 relay
```

The proxy must enforce the intended hostname and **replace**, rather than pass
through, these client-supplied values:

| Header | Trusted value |
| --- | --- |
| `Host`, `X-Forwarded-Host` | Public relay hostname |
| `X-Forwarded-Proto` | `https` at the TLS terminator |
| `CF-Connecting-IP` | Verified client address from the proxy |
| `CF-Ray` | Remove it; it is not a trusted request identifier here |

This is necessary for exact-Origin checks, secure session cookies, webhook URLs,
IP restrictions and login audit records. celld exposes an empty `request.cf`
object, so the current application reads `CF-Connecting-IP`; allowing visitors
to supply that header would falsify their recorded IP. If a load balancer sits
in front of nginx, configure real-IP handling for that balancer's trusted
addresses first. Do not trust arbitrary incoming `X-Forwarded-For` values.

Keep the container listener reachable only by the trusted proxy. Port **8081**
is celld's private peer/operator interface; it is not published by Compose and
must never be exposed through an Ingress or public load balancer. The dashboard
key does not protect that interface. See the upstream
[forwarded-header policy](https://github.com/denoland/celld/blob/v0.6.3/docs/security.md#set-the-forwarded-header-policy).

## Update or rotate the admin key

For a source update, pull your reviewed version, then run from `deploy/celld`:

```sh
docker compose build
docker compose run --rm publish
docker compose up -d --force-recreate --wait --wait-timeout 360 relay
```

For a prebuilt image, use an immutable registry tag or digest in `RELAY_IMAGE`
and `docker compose pull` instead of building locally. Use the same image for
publishing and serving. `docker compose up` alone does not publish a new Worker.

To rotate the admin key, replace `secrets/API_KEY`, retain its permissions, and
rerun `docker compose run --rm publish`. The updated binding is loaded from the
fleet deployment; existing admin sessions become invalid. Changing only a
container environment variable or Secret file without republishing does not
change the application key. Application ingestion keys remain managed in the
dashboard independently.

Preserve all of these across releases:

- `CELLD_BUCKET`, including its prefix.
- Worker name, Durable Object class names, bindings and migration history.
- Compose project name and named volume, or explicitly reattach the existing
  volume if you relocate the deployment.

A code rollback republishes the previous image against the same fleet. It does
not reverse schema migrations or restore a historical database; review backward
compatibility before rolling back.

## Operate and back up

From `deploy/celld`:

```sh
docker compose ps
docker compose logs --tail 100 relay
docker compose run --rm --no-deps relay diagnose
```

Restart or stop without deleting state:

```sh
docker compose restart relay
docker compose down
```

`down` preserves named volumes. **Do not add `--volumes`** unless you intend to
delete local state. Retain the bucket and configure backups/versioning appropriate
to your storage provider; a volume is not a substitute for a bucket backup.
Restore a consistent fleet snapshot into a separate prefix while the target
fleet is stopped, then validate it before switching traffic. Do not restore old
objects over a running fleet. No automated cross-platform data migration or
point-in-time restore tool is provided by this repository.

The image entrypoint supports `publish`, `serve`, `diagnose`, and `version`.
`CELLD_STATE_DIR` defaults to `/var/lib/celld`; the wrapper maps it to celld's
supported local directory option. `CELLD_DURABILITY=bucket` waits for bucket
persistence. The deployment gives the process 60 seconds for graceful shutdown.

## Runtime differences

- The runtime is pinned to **celld v0.6.3 beta**. Self-hosted packaging is available,
  but this does not turn the upstream runtime into a generally available service.
- Country metadata is unavailable (`XX`). Keep country policies **off** when
  self-hosting: an enabled policy intentionally returns `COUNTRY_BLOCKED` when
  the country cannot be determined. Adding `CF-IPCountry` at a proxy does not
  populate `request.cf.country`.
- IP controls and login IP auditing require the trusted header configuration
  above. Cloudflare edge services such as WAF, GeoIP and distributed rate limiting
  are not added by celld.
- The existing in-memory application cache remains in memory. Durable data and
  scheduled work live in the fleet's persistent storage.
- Earlier Docker/Pod replacement checks preserved application data and pending
  retry alarms with storage intact. They did not establish multi-node HA, storage
  loss recovery, or exactly-once delivery for all failure cases. Telegram may
  have accepted a request before a connection fails; inspect delivery outcomes
  before retrying an uncertain send.
- A fresh bucket starts a fresh deployment. Existing Cloudflare Durable Objects
  are not automatically copied over.

Official references: [celld runtime](https://github.com/denoland/celld/blob/v0.6.3/docs/README.md),
[compatibility](https://github.com/denoland/celld/blob/v0.6.3/docs/cloudflare-compat.md),
[storage guarantees](https://github.com/denoland/celld/blob/v0.6.3/docs/guarantees.md).
