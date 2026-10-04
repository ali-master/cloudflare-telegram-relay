# Multiple bots per tenant

A tenant can connect any number of Telegram bots. Select **Tenant → Bot** in the dashboard header to work with one bot's applications, subscribers, settings, reports, and incident policies. The **Bots** page searches and paginates all bots in the tenant.

## Connect and manage

1. Create a Telegram bot with BotFather.
2. Open **Bots → Add bot** and provide an ID, display name, and token.
3. Register its webhook using your deployed HTTPS origin.
4. Select the bot and create an application. Save the generated application API key.
5. Ask recipients to send `/start` to this bot.

Tokens are verified before saving and never returned by administration endpoints. Rotating a token must retain the same Telegram identity; to use a different Telegram bot, add a new bot record. One Telegram identity cannot be attached to two records, including across tenants.

Applications belong to exactly one bot. The association cannot change after creation: moving an application returns `409 APPLICATION_BOT_IMMUTABLE`. Create a new application for the other bot instead. Application IDs remain unique across the tenant.

## Telegram command menu

The relay registers `/start`, `/apps`, `/all`, `/stop`, `/preferences`, `/timezone`, and `/quiet` with Telegram's [setMyCommands](https://core.telegram.org/bots/api#setmycommands) API and sets the default private-chat menu button to **Commands**. Each bot gets its own registration when it is connected, its token is saved, or its webhook is registered. Commands with arguments include usage examples in their descriptions; Telegram inserts the command and the user supplies the arguments. Connecting a bot or changing its token saves the local configuration only after Telegram confirms the menu setup; a failed setup preserves the previous local configuration so the operation can be retried.

For an existing bot, select **Tenant → Bot → Settings → Register commands**. Repeat this after changing command settings manually in BotFather if you want to restore the relay's list. The operation uses the selected bot's saved credentials and does not require a new token or webhook. A configured disabled bot can have its menu updated without enabling it or sending messages.

Registration targets `all_private_chats`, matching the relay's private-chat subscription support. Persian descriptions are installed for `language_code: "fa"` and the empty-language fallback. Other language-specific or chat-specific command overrides are left unchanged and can take precedence in Telegram; remove those overrides in Telegram if a particular user still sees a custom list. Group command settings are unchanged.

To synchronize through the administration API, use an authenticated dashboard session and its exact origin:

```sh
curl --fail-with-body "$RELAY_URL/api/admin/tenants/$RELAY_TENANT/bots/$RELAY_BOT/commands" \
  --request POST \
  --cookie "$RELAY_ADMIN_COOKIE" \
  --header "Origin: $RELAY_URL"
```

No request body is needed. A successful response is `{ "ok": true, "commands": [...] }`, with the registered command names and descriptions. The endpoint allows five requests per minute shared across the tenant’s bots. A missing bot returns `404`; an unconfigured bot returns `503`. Telegram rejection, throttling, and connection failures return `502 TELEGRAM_COMMANDS_SYNC_FAILED` without raw upstream details. Retrying registration is safe; a partial upstream failure can be repaired by registering again.

## Sending notifications

The producer URL and payload stay the same:

```sh
curl --fail-with-body "$RELAY_URL/api/v1/tenants/$RELAY_TENANT/notifications" \
  --header "X-API-Key: $RELAY_APPLICATION_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"event":"deploy.completed","level":"success","text":"Deployment is healthy."}'
```

The application key determines the bot. A query parameter cannot redirect that key to another bot. Grafana and Alertmanager use the same association. Delivery reports accessed with an application key remain limited to that application's notifications.

## Disable and resume

Disabling a bot blocks new notifications from all associated applications, including dashboard sends. The API returns HTTP **409**:

```json
{
  "error": {
    "code": "BOT_DISABLED",
    "message": "بات این اپلیکیشن غیرفعال است؛ برای ارسال اعلان، بات را در داشبورد فعال کنید."
  }
}
```

Treat this as a configuration issue: re-enable the bot before retrying. Reports remain accessible. Pending deliveries, digests, and escalation pause and resume after re-enabling, with current permissions and retention rules applied. An HTTP request already sent to Telegram can still complete. There is no fallback to another bot.

Authenticated Telegram updates received while disabled cannot enroll users or send replies. `/stop` and blocked/left updates still remove subscriptions, so re-enabling never overrides an opt-out. The user's `/start` should be sent again after the bot is enabled. Disabling an entire tenant blocks every bot it contains.

## Isolation and shared limits

| Per bot | Shared across its tenant |
| --- | --- |
| Token, webhook secret, enabled state | Requests per minute |
| Subscribers, bans, application choices | Notifications per UTC day |
| Notifications, queue, delivery reports | Active subscription quota |
| Delivery speed, welcome message, retention | Pending-delivery capacity |
| Automation defaults, incidents, digests | Application IDs and existing application-count limit |

The same person starting two bots has two independent subscriptions and consumes two subscription slots. Extra bots do not multiply tenant quotas. The default bot's IP/country restrictions remain the tenant baseline; additional bots can impose further restrictions through their own settings. Both policies must allow a producer request.

`GET /api/admin/tenants/{tenantId}/usage?botId={botId}` returns aggregate tenant `usage`, selected `botUsage`, and shared `limits`.

## Administration API

Log in through `/api/admin/login` to obtain the dashboard session cookie. Mutations require an `Origin` header exactly matching the deployment origin. All paths below are relative to `/api/admin/tenants/{tenantId}`; `/api/admin` is the default-tenant alias.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/bots?page=1&search=ops` | `{items, total, page, pageSize}`; pages of 20 |
| POST | `/bots` | `{id, name, botToken, enabled?}` → `{bot}` |
| GET | `/bots/{botId}` | `{bot}` with its latest `version` |
| PATCH | `/bots/{botId}` | `{name?, enabled?, botToken?, expectedVersion?}` → `{bot}` |
| GET | `/bots/{botId}/status` | Cached Telegram bot/webhook status |
| POST | `/bots/{botId}/webhook` | `{url: "https://relay.example/telegram/{tenantId}/bots/{botId}/webhook"}` |
| POST | `/bots/{botId}/commands` | No body → `{ok: true, commands: [{command, description}]}` |
| POST | `/applications?botId={botId}` | `{id, name, ...audienceOptions}` → application and one-time API key |

Use the latest `version` as `expectedVersion` when editing. A stale edit returns `409 STALE_BOT`; reload before saving. A token assigned elsewhere returns `409 BOT_ALREADY_ASSIGNED`.

Add `?botId={botId}` to existing settings, subscribers, reports, automation, and incident admin routes. Omission selects `default`. The application list is the exception: without a bot filter it lists the tenant's applications; with `botId` it lists only that bot's applications. Application creation also accepts `botId` in the body, but when both forms are supplied they must match.

## Upgrading an existing deployment

Deploy the code with the existing Durable Object bindings and migration history intact. No new secret, binding, database, or manual data migration is needed.

The existing bot becomes `default`, preserving its token, webhook secret, subscribers, application keys, bans, queues, and reports. Existing applications receive `botId: "default"`. Old `/telegram/webhook` and `/telegram/{tenantId}/webhook` routes keep working for the default bot. The legacy `PUT /api/admin/tenants/{tenantId}/bot` remains a default-bot token configuration alias; use `/bots` for new integrations.

After upgrading, use **Settings → Register commands** for each existing bot to publish the full command menu. Registering its webhook also synchronizes the menu.

See [OpenAPI](openapi.yaml) for schemas and [delivery automation](automation.md) for policies and incident endpoints.
