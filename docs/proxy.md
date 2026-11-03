# Proxy

`proxy/server.js` gives every published application a stable URL, `/apps/<appId>/`, that works from any VM. A user can land on any VM and still reach the VM that actually runs their app.

It uses only Node's built-in modules, so there is nothing to install from a registry on the VMs.

## How it works

```
user ──► any VM :8080 (proxy) ──► registry/<appId>.json ──► <ip>:<port> of the owning VM
```

1. A request arrives at the proxy on whichever VM the user reached.
2. If the path is `/apps/<appId>/...`, the proxy reads `<shared>/registry/<appId>.json`.
3. It forwards the request, unchanged, to the `ip` and `port` in that entry.
4. Any other path goes to the builder UI (`BUILDER_URL`), so users have one entry point for both the editor and their apps.

The same code runs on every VM and has no per-VM state. All state is in the registry on the shared volume, which the publisher writes (see `project-generator.md`).

## Routing rules

| Request | Result |
|---|---|
| `/apps/<appId>/…` and the app is registered and `running` | Forwarded to `ip:port`, with the full path kept |
| `/apps/<appId>` (no trailing slash) | `308` redirect to `/apps/<appId>/`, query string kept |
| `/apps/<appId>/…` and no registry file | `404` |
| `/apps/<appId>/…` and `status` is not `running` | `503` |
| The registered process is not reachable | `502`, and the cached entry is dropped so the next request re-reads the registry |
| `/_proxy/health` | `200 ok` |
| Anything else (`/`, `/api/publish`, …) | Forwarded to the builder |

The path is kept because published apps are built with `BASE_PATH=/apps/<appId>`. Their assets are requested under that prefix, so the proxy never rewrites paths and the app's own server strips the prefix.

An app id must match `[a-z0-9][a-z0-9-]{2,39}`. A path that does not match is treated as a builder path, which also means `/apps/../…` cannot read arbitrary files.

## Headers

The proxy sets `Host` to the target, and adds `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For`. An existing `X-Forwarded-Proto` or `X-Forwarded-For` (for example from a load balancer in front) is kept and extended.

## Registry caching

The proxy reads one file per request, `registry/<appId>.json`, and caches the result for `REGISTRY_CACHE_MS` (default 1000 ms) so a busy app does not hit the shared volume on every request.

After a republish, the stable URL therefore switches to the new release within about a second. A `502` clears the cache for that app, so recovery after a restart or move is also quick.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `8080` | Port the proxy listens on |
| `SHARED_DIR` | `./.shared` | Shared volume root. The registry is `$SHARED_DIR/registry/` |
| `BUILDER_URL` | `http://127.0.0.1:3000` | Where non-`/apps` requests go. Normally the builder on the same VM |
| `REGISTRY_CACHE_MS` | `1000` | Registry cache time per app |
| `APP_TIMEOUT_MS` | `30000` | Idle timeout for requests to a published app |
| `BUILDER_TIMEOUT_MS` | `600000` | Idle timeout for requests to the builder (publishing is slow) |

Set `PUBLIC_BASE_URL` on the **builder** (not the proxy) to the address users reach the proxy at, for example `http://<host>:8080`. The publisher then returns that as the app's stable `url`, and the Publish button links to it.

## Running it

```bash
# on every VM, from the builder directory
SHARED_DIR=/shared PROXY_PORT=8080 BUILDER_URL=http://127.0.0.1:3000 npm run proxy
```

Run it under whatever process manager the VM uses (systemd, for example) so it restarts on failure.

## Verified

- `npm run proxy:test` runs 9 tests against a fake app and a fake builder:
  - forwarding keeps the path and query string, and sets the forwarded headers;
  - a missing trailing slash redirects;
  - an unknown app returns 404, and a stopped app returns 503;
  - a dead process returns 502 and recovers after the registry is fixed;
  - an app that is too slow gets 502 while a slow builder request still succeeds;
  - non-app paths reach the builder, `/apps/../…` is not treated as an app path, and the health endpoint answers.
- End to end, with the real builder, the proxy and a published app:
  - the editor loaded through the proxy (200);
  - `POST /api/publish` through the proxy returned release 1 with `url` `http://127.0.0.1:8085/apps/demo-app/`;
  - the app page and its asset loaded through that URL, and `/apps/demo-app` redirected to the slash form;
  - a republish kept the same URL and served release 2;
  - after the app process was killed, the URL returned 502;
  - an unregistered app returned 404.

## Current limits

- **No WebSockets:** upgrade requests are not forwarded. The generated apps do not use them, but a Next.js dev server or a future app with sockets would need it.
- **No TLS and no auth:** the proxy speaks plain HTTP and does not check who the user is. Put it behind the bank's gateway, or add OAuth 2.0 in version 2.
- **No load balancing across instances of one app:** each registry entry points at one `ip:port`. Several instances per app (autoscaling) would need a list of targets and a choice between them.
- **Dead-process recovery is separate:** the proxy only reports a `502`. Restarting the app and updating the registry is the reconciler's job (`reconciler.md`).
- **Cross-VM reachability is assumed:** the proxy on one VM must be able to reach the app ports on the other (for example the `PORT_MIN`-`PORT_MAX` range in the security group).
- **Upstream timeouts:** requests to an app time out after 30 seconds of silence (`APP_TIMEOUT_MS`). Requests to the builder get 10 minutes (`BUILDER_TIMEOUT_MS`), because `/api/publish` runs `npm install` and a build.
