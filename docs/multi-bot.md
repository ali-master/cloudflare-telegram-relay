# Multiple bots per tenant

A tenant can connect any number of Telegram bots. Select **Tenant → Bot** in the dashboard header to work with one bot's applications, subscribers, settings, reports, and incident policies. The **Bots** page searches and paginates all bots in the tenant.

## Connect and manage

1. Create a Telegram bot with BotFather.
2. Open **Bots → Add bot** and provide an ID, display name, and token.
3. Register its webhook using your deployed HTTPS origin.
4. Select the bot and create an application. Save the generated application API key.
5. Ask recipients to send `/start` to this bot.

Tokens are verified before saving and never returned by administration endpoints. Rotating a token must retain the same Telegram identity; to use a different Telegram bot, add a new bot record. One Telegram identity cannot be attached to two records, including across tenants. When a token is already connected elsewhere, the authenticated admin receives `409 BOT_ALREADY_ASSIGNED` with the existing tenant and bot names, so the connection can be found without exposing its credentials.

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

## Delete a tenant, bot, or application

Use **Delete** on the corresponding dashboard entry and type its exact ID in the
confirmation dialog. The dialog identifies the selected tenant/bot and explains
what will be removed. Deletion is permanent; use **Disable** when you want to
pause delivery and keep the configuration and reports.

| Resource | Removed by deletion | What remains |
| --- | --- | --- |
| Tenant | Its bot connections, application keys, subscribers, settings, queued work, automation and delivery history | Other tenants and the global login audit |
| Bot | Its connection, application keys, subscribers, settings, queued work, automation and delivery history | Other bots in the same tenant; a deleted default bot's IP/country restrictions are retained as the tenant baseline |
| Application | Its key, notification/queue history and application-specific automation; its ID is removed from subscription selections | The bot, subscribers and other applications |

The default tenant **can be deleted**, including its bots and applications. Every bot, including a bot
whose ID is `default`, can be deleted. A tenant may have no bots; create a new
bot from its Bots page to use it again. Deleting the default bot retains a
snapshot of its IP/country restrictions as the tenant baseline, so the deletion
does not silently broaden access for the remaining bots.

The tenant editor shows when inherited restrictions remain. To remove that
baseline deliberately, select **Clear inherited access restrictions** and save
the tenant. The API exposes this state as `tenant.hasInheritedAccess`; send
`PATCH /api/admin/tenants/{tenantId}` with
`{"clearInheritedAccess":true,"expectedVersion":3}` using the current tenant
version. This clears only the retained baseline; each remaining bot keeps its
own access rules. Leaving the checkbox unchecked preserves the baseline.

Once deletion is accepted, the resource disappears from active lists and its
keys and webhook access stop working. Pending sends are canceled as part of
cleanup. An HTTP request already sent to Telegram may still finish, and messages
already delivered are not recalled.

Cleanup is durable and retried after transient failures or a runtime restart.
The response contains `cleanupPending: true` when that work is still outstanding;
this does not mean the resource is active again. Bot/tenant cleanup requests
removal of the Telegram webhook with
[`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook) and asks
Telegram to discard pending updates. It does **not** delete the Telegram bot
account created through BotFather. The Telegram identity stays reserved while
webhook cleanup is pending, preventing a delayed cleanup from disconnecting a
new owner. Telegram `401`/`404` responses are terminal when the saved token no
longer authorizes cleanup; local removal can finish without proving the old
webhook was removed. Use a valid token and register the new webhook when
reconnecting. After cleanup completes, connect that Telegram identity using a
new record ID.

Deleted tenant IDs remain reserved globally; bot and application IDs remain
reserved inside their original tenant. Reusing one returns
`409 RESOURCE_ID_RETIRED`, even after cleanup finishes. This prevents stale
requests, API keys, callbacks or alarms from reaching a newly created resource
with the old identity.

For administration integrations, send the latest resource `version` in a JSON
body. Use an authenticated admin session and the exact deployment origin:

```sh
# Read the bot first and use its current version, for example 3.
curl --fail-with-body "$RELAY_URL/api/admin/tenants/$RELAY_TENANT/bots/$RELAY_BOT" \
  --request DELETE \
  --cookie "$RELAY_ADMIN_COOKIE" \
  --header "Origin: $RELAY_URL" \
  --header 'Content-Type: application/json' \
  --data '{"expectedVersion":3}'
```

The successful response is `{ "deleted": true, "cleanupPending": false }` or
the same object with `cleanupPending: true`. A missing/invalid version or extra
body fields return `400 INVALID_DELETION`. A stale version returns
`409 STALE_TENANT`, `STALE_BOT`, or `STALE_APPLICATION`; reload the resource and
confirm the newly displayed state before retrying.
Repeating a deletion with the same version can return its remaining cleanup
state while the parent resource still exists. Background cleanup also proceeds
without polling or another delete request.

## Isolation and shared limits

| Per bot | Shared across its tenant |
| --- | --- |
| Token, webhook secret, enabled state | Requests per minute |
| Subscribers, bans, application choices | Notifications per UTC day |
| Notifications, queue, delivery reports | Active subscription quota |
| Delivery speed, welcome message, retention | Pending-delivery capacity |
| Automation defaults, incidents, digests | Application IDs and existing application-count limit |

The same person starting two bots has two independent subscriptions and consumes two subscription slots. Extra bots do not multiply tenant quotas. The default bot's IP/country restrictions form the tenant baseline; additional bots can impose further restrictions through their own settings. Both policies must allow a producer request. Deleting the default bot preserves its last restrictions as the tenant baseline instead of removing those checks.

`GET /api/admin/tenants/{tenantId}/usage?botId={botId}` returns aggregate tenant `usage`, selected `botUsage`, and shared `limits`.

## Administration API

Log in through `/api/admin/login` to obtain the dashboard session cookie. Mutations require an `Origin` header exactly matching the deployment origin. All paths below are relative to `/api/admin/tenants/{tenantId}`; `/api/admin` is the default-tenant alias.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/bots?page=1&search=ops` | `{items, total, page, pageSize}`; pages of 20 |
| POST | `/bots` | `{id, name, botToken, enabled?}` → `{bot}` |
| GET | `/bots/{botId}` | `{bot}` with its latest `version` |
| PATCH | `/bots/{botId}` | `{name?, enabled?, botToken?, expectedVersion?}` → `{bot}` |
| DELETE | `/bots/{botId}` | `{expectedVersion}` → `{deleted: true, cleanupPending}` |
| GET | `/bots/{botId}/status` | Cached Telegram bot/webhook status |
| POST | `/bots/{botId}/webhook` | `{url: "https://relay.example/telegram/{tenantId}/bots/{botId}/webhook"}` |
| POST | `/bots/{botId}/commands` | No body → `{ok: true, commands: [{command, description}]}` |
| POST | `/applications?botId={botId}` | `{id, name, ...audienceOptions}` → application and one-time API key |
| GET | `/applications/{applicationId}?botId={botId}` | `{application}` with its latest `version`; validates the selected bot scope |
| DELETE | `/applications/{applicationId}` | `{expectedVersion}` → `{deleted: true, cleanupPending}` |

Delete an entire tenant with `DELETE /api/admin/tenants/{tenantId}` and the same
`{expectedVersion}` body. There is no default-tenant deletion alias.

Use the latest `version` as `expectedVersion` when editing, and always supply it
when deleting. A stale bot edit returns `409 STALE_BOT`; reload before saving.
A token assigned elsewhere returns `409 BOT_ALREADY_ASSIGNED` with a message
naming the existing tenant and bot and the following public owner metadata:

```json
{
  "error": {
    "code": "BOT_ALREADY_ASSIGNED",
    "message": "…",
    "owner": {
      "tenantId": "operations",
      "tenantName": "Operations",
      "botId": "alerts",
      "botName": "Production alerts"
    }
  }
}
```

These details are returned only by authenticated administration requests. Tokens,
webhook secrets and application keys are never included in this error.

Add `?botId={botId}` to existing settings, subscribers, reports, automation, and incident admin routes. Omission selects `default`. The application list is the exception: without a bot filter it lists the tenant's applications; with `botId` it lists only that bot's applications. Application creation also accepts `botId` in the body, but when both forms are supplied they must match.

## Upgrading an existing deployment

Deploy the code with the existing Durable Object bindings and migration history intact. No new secret, binding, database, or manual data migration is needed.

The existing bot becomes `default`, preserving its token, webhook secret, subscribers, application keys, bans, queues, and reports. Existing applications receive `botId: "default"`. Old `/telegram/webhook` and `/telegram/{tenantId}/webhook` routes keep working for the default bot. The legacy `PUT /api/admin/tenants/{tenantId}/bot` remains a default-bot token configuration alias; use `/bots` for new integrations.

After upgrading, use **Settings → Register commands** for each existing bot to publish the full command menu. Registering its webhook also synchronizes the menu.

See [OpenAPI](openapi.yaml) for schemas and [delivery automation](automation.md) for policies and incident endpoints.


## Reset project data

Open **Settings → Reset project data**, then type `RESET ALL DATA` and confirm.
This removes all tenants (including `default`), bots, application keys, subscribers,
notifications, queue payloads, settings, automation and login audit entries.
The `API_KEY` environment secret and dashboard login remain valid. No default
resources are recreated automatically; create a new tenant after completion.

`POST /api/admin/reset` accepts only `{"confirmation":"RESET ALL DATA"}` and requires
an admin session, JSON content type and exact browser Origin. It returns HTTP 202
with `{running, startedAt, completedAt, pending}`. `GET /api/admin/reset` returns
that same progress shape. Writes to new or existing tenant resources are rejected
with `409 PROJECT_RESETTING` until cleanup finishes. Provider failures are retried
from durable storage, including after restart.

Minimal deletion fences (retired IDs) and reset progress are retained to prevent
stale requests from restoring removed data. Retired IDs cannot be reused. Existing
Telegram messages remain and an already-started send can finish. The Telegram bot
accounts themselves are not deleted. External backups and deployment secrets are
outside this operation.
