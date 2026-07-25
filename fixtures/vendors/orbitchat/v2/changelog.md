# Changelog

## 2.0.0 — 2026-07-26

### Breaking changes

- Replaced `client.messages.send` with `client.messages.create`.
- Renamed request field `room` to `channelId`.
- Renamed request field `text` to `content`.
- Replaced explicit `notify` values with
  `notification: { enabled: boolean }`.
- Renamed response field `message_id` to `id`.
- Renamed response field `created_at` to `createdAt`.
- Dropped Node.js 18 support. Node.js 22 or newer is required.

Notification behaviour when the option is omitted can vary by account policy.

## 1.0.0 — 2026-07-24

- Initial synthetic SDK release.
- Added `client.messages.send`.
