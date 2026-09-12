# Telegram Relay

A lightweight Telegram notification gateway for monitoring, alerts, and CI/CD, running on Cloudflare Workers.

Each **tenant** has its own bot, applications, subscribers, limits, and reports. Each **application** gets an API key for sending notifications.

- Text, images, severity, timestamps, metadata, and incident links.
- Persian RTL dashboard with locally hosted Estedad and light, dark, or system theme.
- IP/CIDR and country restrictions, quotas, and individual or bulk subscriber bans.
- Admin-only failed-login audit with IP, country, time, and client details.
- Telegram application subscriptions: receive everything by default, or choose specific apps.
- Persistent delivery queues and reports in SQLite Durable Objects, with caching to reduce database reads.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ali-master/cloudflare-telegram-relay)

You need a Cloudflare account and a Telegram bot from [@BotFather](https://t.me/BotFather).

1. Use the deploy button, connect GitHub or GitLab, and choose your repository and Worker names.
2. Set **`API_KEY`** to a unique admin login key. Generate one with `openssl rand -hex 32` and save it in your password manager.
3. Deploy, open the Worker URL, and log in with that key.

Cloudflare creates the required Durable Objects from `wrangler.jsonc`. No separate database or queue setup is needed.

### Deploy from your terminal

With **Node.js 22+** and npm, run:

```sh
git clone https://github.com/ali-master/cloudflare-telegram-relay.git
cd cloudflare-telegram-relay
npm ci
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Paste the generated value into `API_KEY` in `.dev.vars`. Review the Worker name in `wrangler.jsonc`, then deploy:

```sh
npx wrangler login
npm run deploy -- --secrets-file .dev.vars
```

The first deployment uploads the code and admin secret together. For later code updates, use `npm run deploy`; Cloudflare retains the existing secret.

### Where configuration lives

| Setting | Where to configure it |
| --- | --- |
| Admin login `API_KEY` | Cloudflare Worker Secret; locally, `.dev.vars` |
| Bot token and webhook | Dashboard → select a tenant → Settings |
| Application API keys | Dashboard → Applications |
| Tenant quotas | Dashboard → Tenants |
| IP/country restrictions and delivery settings | Dashboard → Settings |

`API_KEY` is the only required environment secret. Its name is declared in `wrangler.jsonc` under `secrets.required`; the value stays out of source control. `.dev.vars.example` and `package.json` describe the secret for the deploy button.

To change the key later, run `npx wrangler secret put API_KEY`, or open **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, choose **Secret**, enter `API_KEY`, and **Deploy**. Changing the key signs out existing admin sessions.

## Connect your bot

1. Log in to the dashboard and select the default tenant, or create a tenant.
2. In **Settings**, paste its BotFather token and save it. The relay verifies the bot and generates its webhook secret.
3. Click **Register webhook** on the deployed HTTPS URL.
4. In **Applications**, create an application and save the generated API key; it is only shown when created or rotated.
5. Open the bot in Telegram and send `/start`.

Use a separate bot for each tenant. Telegram webhooks need public HTTPS; localhost cannot receive Telegram updates.

## Send your first notification

For ready-to-copy requests, select a tenant in the dashboard and open **API Guide**. The page uses that tenant's URL and limits, with examples for sending and tracking notifications. Each tenant also has an API Guide shortcut in **Tenants**.

Replace the URL, tenant ID, and application key below. Use the application's key, **not** the admin login key.

```sh
export RELAY_URL='https://your-relay.your-subdomain.workers.dev'
export RELAY_TENANT='default'
export RELAY_APPLICATION_KEY='replace-with-your-application-key'

curl --fail-with-body "$RELAY_URL/api/v1/tenants/$RELAY_TENANT/notifications" \
  --header "X-API-Key: $RELAY_APPLICATION_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "event": "deployment.completed",
    "level": "success",
    "text": "Version 1.0.0 is live.",
    "environment": "production",
    "url": "https://ci.example.com/pipelines/123"
  }'
```

Only `event` and `text` are required. Optional fields include `title`, `timestamp`, `image` (HTTPS URL or Telegram file ID), `metadata`, `tags`, and `silent`. The API key identifies the application automatically. `Authorization: Bearer <application-key>` also works.

A `202` response means the notification was accepted; delivery runs in the background when there are eligible subscribers. Track delivery in the dashboard or with `GET /api/v1/tenants/{tenantId}/notifications/{id}`, using the same key. Add an `Idempotency-Key` header when retrying requests; keep the payload and key unchanged for retries, and use a new key for a new event.

See [integration recipes](docs/integrations.md) for **GitHub Actions, GitLab CI, Alertmanager, and Grafana**, or the [OpenAPI reference](docs/openapi.yaml) for all endpoints and payload fields.

### Telegram message layout

Notifications use Telegram's structured Rich Messages as a technical report, with a Persian heading, the literal body, and an optional photo inside the same message. Details stay visible in native monospace blocks: **CONTEXT** contains the application, event, environment, severity, and optional country flag; **TIME** shows numeric Jalali and Gregorian dates with a shared time in **Asia/Tehran**, using ASCII digits for both calendars. Optional **METADATA** and **TAGS** blocks follow.

Metadata keeps scalar key/value pairs intact. Long or Persian keys and values place the value beneath its key without truncation; the renderer adds no hidden direction-control characters. The report uses neither tables nor collapsed sections. Actions include an optional primary incident-link button and separate event/notification-ID copy buttons; the UUID appears only through its copy button.

Keep sending the same JSON fields. Text, titles, and metadata remain literal content; submitted HTML or Markdown is not interpreted. The relay builds the formatting itself. The API retains its **3,000-character text** limit and **4,000-character complete plain-text validation** limit; these are project limits, not Telegram's Rich Message limits.

The renderer uses the [Telegram Bot API's Rich Messages and buttons](https://core.telegram.org/bots/api#sendrichmessage). Telegram describes rendering in [supported clients](https://core.telegram.org/bots/features#messages-and-formatting), but does not document a minimum client version or guarantee an automatic fallback for older clients.

## Subscriber controls

| Telegram command | Action |
| --- | --- |
| `/start` | Subscribe to the bot's notifications |
| `/apps` | Choose which permitted applications to receive |
| `/all` | Receive notifications from every permitted application |
| `/stop` | Stop receiving notifications |

New and existing subscribers initially have access to all current and future applications. In **Subscribers**, admins can edit a display-name override, private notes, and the applications each subscriber may receive. These changes preserve the Telegram name, username, and chat ID. Clearing the display name restores the Telegram name.

Admin permissions and the subscriber's Telegram preferences are independent: delivery requires both to allow the application. `/all` cannot bypass admin restrictions. With admin access set to **Selected applications**, an empty selection permits no applications. With access set to **All applications**, future applications are permitted too.

Each application also has its own audience in **Applications**: all current/future subscribers, or up to 1,000 selected existing subscribers in that tenant. An empty selected audience receives nothing. Delivery requires the application audience, subscriber admin permissions, and Telegram preferences all to permit it. **Show in bot directory** controls visibility in `/apps`; hiding an application still allows otherwise-authorized notifications.

Admins can ban users individually or in bulk from **Subscribers**. Profile and application-access edits do not change subscription or ban status. Banned users cannot resubscribe; after unbanning, they must send `/start` again. Bans and access/preference changes can skip pending deliveries; messages already sent cannot be recalled.

For admin integrations, read and patch `/api/admin/tenants/{tenantId}/subscribers/{chatId}` using an admin session; `/api/admin/subscribers/{chatId}` addresses the default tenant. PATCH requires the latest `version` as `expectedVersion`, and the exact deployment `Origin`. Send `accessMode` and `allowedApplicationIds` together: `all` requires an empty array; `selected` restricts delivery to the supplied IDs. `displayName` is limited to 80 characters and `notes` to 1,000. Both subscriber-list routes accept an optional `search` query of up to 100 characters. See the [OpenAPI reference](docs/openapi.yaml) for request and response schemas.

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars
# Fill in API_KEY with a random value.
npm run dev
```

Open [localhost:8787](http://localhost:8787) and log in with your local key. Local SQLite data is stored in `.wrangler/` and is separate from production. Use a separate test bot if you connect a public HTTPS development tunnel.

| Command | Purpose |
| --- | --- |
| `npm run check` | TypeScript checks |
| `npm test` | Run the test suite |
| `npm run deploy:check` | Build a deployment bundle without deploying |
| `npm run cf-typegen` | Regenerate bindings after changing Wrangler config |

The dashboard is plain HTML/CSS/JavaScript in `public/`; the Worker lives in `src/`. Keep Durable Object bindings, class names, and migration history intact when updating an existing deployment.
