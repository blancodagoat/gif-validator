# GifValidator

A Vencord userplugin that validates your Discord favorite GIFs and lets you remove the broken ones. Inspired by [jakeayy/gif-validator](https://github.com/jakeayy/gif-validator), but it runs inside the Discord client through Vencord, so it does not require a token, does not impersonate a self-bot client, and does not depend on the `discord-protos` npm package.

## Usage

- Open the Vencord toolbox and click "Validate Favorite GIFs", OR
- Open the plugin's settings panel in Vencord settings and click "Open Validator".
- Click "Start Validation". Wait for it to finish. Review the broken-GIF list. Uncheck anything you want to keep. Click "Remove Selected".

## How it works

It reads `favoriteGifs.gifs` from Discord's in-memory `FrecencyUserSettings` proto store via `UserSettingsActionCreators.FrecencyUserSettingsActionCreators.getCurrentValue()`.

For each GIF, it makes a HEAD request from Vencord's main process so CORS does not block it. 405 responses fall back to `GET` with `Range: bytes=0-0`. Checks run in a worker pool (default 6 at a time, up to 10): as soon as one finishes, the next GIF starts while others keep running. The default per-request timeout is 15000ms.

On save, it builds a partial proto via `fromBinary(toBinary(current))`, replaces `favoriteGifs.gifs` with the filtered map (with `order` re-numbered 0..n-1), and dispatches `USER_SETTINGS_PROTO_UPDATE` with `type: 2`. Discord's normal sync writes the change upstream; the plugin never calls the REST API directly.

## Settings

- `concurrency` (default 6): how many GIFs are validated in parallel; clamped to 10 in the limiter.
- `timeoutMs` (default 15000): per-request timeout in milliseconds.
- `requireImageOrVideoContentType` (default true): require the response Content-Type to start with `image/` or `video/`.
- `treatRedirectsAsValid` (default true, informational): the native bridge follows redirects automatically.

## Limitations

- **Tenor placeholders**: when a Tenor GIF is removed, Tenor sometimes still returns 200 with a placeholder image. The plugin cannot always tell that apart from a real GIF. The broken-removal flow lets you uncheck items, so spot-check before clicking Remove Selected if in doubt.
- **Hosts that block HEAD**: most respond fine. Some return 405, in which case the plugin retries once with `GET Range: bytes=0-0`.
- **Hosts that block fetches without browser fingerprints**: the plugin uses a generic User-Agent. If a host requires Discord's exact headers, validation may report false-broken. Adjust the selection manually before clicking Remove Selected.
- **Schema drift**: if Discord renames `favoriteGifs` in the proto, the plugin will report "couldn't read favorites" on launch. Check the repo for updates.

## Differences from jakeayy/gif-validator

| jakeayy/gif-validator (CLI) | This plugin |
|---|---|
| Bun script outside Discord | Vencord userplugin inside Discord |
| Asks for user token, sends impersonated Chrome headers (effectively a self-bot) | Uses your authenticated Discord client; no token handling |
| Decodes/encodes the protobuf via `discord-protos` npm | Reads decoded data from Discord's in-memory store; encodes via Discord's own action creators |
| PATCH `/api/v9/users/@me/settings-proto/2` | Dispatches `USER_SETTINGS_PROTO_UPDATE` flux event; Discord's normal sync handles the write |
| Bulk-removes silently | Shows a checkbox list before any deletion |

## License

GPL-3.0-or-later (matching Vencord).
