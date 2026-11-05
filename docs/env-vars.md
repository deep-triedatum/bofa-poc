# Environment variables

Published apps get environment variables from **namespaces** on the shared volume. A namespace is a named set of variables that any number of apps can attach, so a value that several apps need (a backend URL, a database host) is kept in one place. This covers backend apps. Frontend apps need a separate mechanism (see the end).

## Model

| Thing | Stored in | Meaning |
|---|---|---|
| Namespace | `env/namespaces/<name>.json` | `{ name, ait, shared, vars, rev }`. Belongs to one AIT. Attached to apps by name |
| App's own variables | `env/apps/<appId>.json` | `{ appId, ait, vars, rev }`. Private to one app |
| Attachment | `registry/<appId>.json`, field `envNamespaces` | The ordered list of namespaces the app uses |

An app starts with: its namespaces in order (later wins), then its own variables on top. `PORT` and `BASE_PATH` are set last by the platform and cannot be overridden.

```
namespaces: ["common", "payments"]      common:   LOG=info  DB=db1
app's own:  DB=private-db               payments: LOG=debug
result:     LOG=debug  DB=private-db    + PORT and BASE_PATH from the platform
```

Names (namespaces, apps, AITs) use the usual `[a-z0-9][a-z0-9-]{2,39}`. Variable names are `[A-Za-z_][A-Za-z0-9_]*`, at most 128 characters. Values are strings of at most 4096 characters, and at most 200 variables per namespace. `PORT`, `BASE_PATH`, `NODE_OPTIONS`, `PATH`, `LD_PRELOAD` and `LD_LIBRARY_PATH` are refused.

## Who may attach what

A namespace belongs to the AIT that created it, and only that AIT can change it. Apps of other AITs can attach it only if it was marked `shared`. Attaching a namespace that does not exist, or one that is another AIT's and not shared, is refused (404, 403).

## How a change reaches a running app

A running process cannot be given new variables, so it has to be restarted. The app is not restarted by the builder:

1. Every write to a namespace or to an app's own variables raises its `rev`.
2. When an app starts, its registry entry gets `envHash`: a short token built from the names and `rev` numbers of everything that fed into its variables. It is never built from values, so it is safe in the registry.
3. On each tick the reconciler on the VM that owns a healthy app recomputes that token. If it differs from `envHash`, it restarts the app with the new variables (action `env-updated`). This is not counted in `restarts`.

So a change takes up to `RECONCILE_INTERVAL_MS` (5 s) plus the restart. A namespace shared by ten apps restarts all ten, each by its own VM. A stopped app picks the change up the next time it starts. An app on a lost VM is adopted with the current variables. `GET /api/apps/<appId>/env` shows `applied: false` until the restart has happened.

Apps published before this feature have no `envHash`. With no variables attached this is treated as "nothing to apply", so they are not restarted.

## In the editor

**My apps** has two tabs.

- **Environment** lists the namespaces (filtered by the AIT box at the top). **New namespace** asks for a name and an AIT and lets you add variables. **Edit** adds variables, overwrites a value (**Change value**), removes a variable, and sets **shared**. Values are typed into password fields and are never shown again. **Delete** is disabled while an app still uses the namespace, and the list shows which apps do.
- **Applications**: each row has an **Env** button. It opens the app's environment: attach namespaces from the buttons under the list (`+ payments`), put them in order with the arrows (later wins), detach them, and edit the app's own variables. A badge shows **applied**, or **restart pending** until the VM that runs the app has restarted it. A line at the bottom lists the names of everything the app will start with.

Saving sends only what changed. Saving a namespace without changing a value does not restart anything.

## API

Values are **write-only**: every response lists variable names, never values.

| Request | Result |
|---|---|
| `GET /api/env` or `?ait=<ait>` | `{ namespaces: [{ name, ait, shared, keys, usedBy, updatedAt }] }`. With `ait`: its own plus the shared ones |
| `GET /api/env/<namespace>` | One namespace, as above |
| `PUT /api/env/<namespace>` `{ ait, shared?, set?, unset? }` | Creates the namespace (`ait` required) or changes it. `set` is `{ NAME: "value" }`, `unset` is a list of names |
| `DELETE /api/env/<namespace>` | `{ deleted: true }`. `409` while an app still uses it |
| `GET /api/apps/<appId>/env` | `{ namespaces, keys, effectiveKeys, missing, denied, applied }` |
| `PUT /api/apps/<appId>/env` `{ namespaces?, set?, unset? }` | `namespaces` replaces the attached list. `set` and `unset` change the app's own variables |
| `POST /api/publish` `{ ..., envNamespaces }` | Attaches namespaces when publishing. Omitted, a republish keeps what the previous release had |

```bash
curl -X PUT localhost:3000/api/env/payments -H 'content-type: application/json' \
  -d '{"ait":"default","set":{"API_URL":"https://payments.internal","LOG":"info"}}'
curl -X PUT localhost:3000/api/apps/my-first-app/env -H 'content-type: application/json' \
  -d '{"namespaces":["payments"]}'
curl localhost:3000/api/apps/my-first-app/env     # applied: false, then true after the reconciler's restart
```

## Code

| What | Where |
|---|---|
| Storage, merge, validation, the change token | `runtime/env.js` |
| Passing variables to the process | `startApp` in `runtime/lifecycle.js` (`env`) |
| Restart on change, variables on restart and adoption | `reconciler/server.js` (`start`, and the healthy branch of `tick`) |
| Variables on publish | `src/server/publisher.ts` |
| UI | `src/components/AppsPanel.tsx` (tabs, **Env** button) and `src/components/apps/` (`EnvTab`, `NamespaceEditor`, `AppEnvEditor`, `VarEditor`) |
| Server functions and API routes | `src/server/env.ts`, `src/pages/api/env/`, `src/pages/api/apps/[appId]/env.ts` |

## Verified

- `npm run env:test` (13 tests): merge order, two apps on one namespace, token changes and holds no values, reserved and malformed names, AIT scoping, in-use delete, files are `0600`.
- `npm run reconciler:test` (4 new, 19 in all), with real stand-in servers that echo their environment: a restarted app has its variables and the platform's `PORT` and `BASE_PATH`; changing a namespace restarts both apps that share it with the new value and without counting a restart, and a second tick does nothing; an app on another live VM is left alone; an app from before this feature is not restarted.
- `src/server/env.test.ts` (6 tests): names only in responses, attaching, `applied`, refusals, listing by AIT, deleting.
- In a real browser (headless Chromium driving `next dev`, one reconciler, a stand-in app that echoes its environment): created a namespace with two variables, attached it to the app and added an own variable, and the running process had all three after the restart (badge went to **applied**). Changing a value in the namespace restarted the app with the new value, and **Delete** was disabled while the namespace was in use.
- **Not tested:** the publish route with `envNamespaces` (publishing needs `npm install`), the shared and other-AIT flows in the UI, and two real VMs.

## Current limits

- **UI scope:** you cannot see values, and the AIT filter box at the top also filters the Environment tab, so a namespace of an AIT you are not filtering for is hidden there.
- **No login.** Anyone who can reach the API can read which variables exist and change any AIT's namespace by naming that AIT. The AIT check only separates what an app may attach, it is not authentication.
- **Secrets are plain JSON on the shared volume,** readable by the user the builder and reconciler run as (files are `0600`, so the two must run as the same user). There is no encryption and no vault. Responses never return values, but anyone with access to the volume can read them.
- **Apps still inherit the reconciler's own environment** as before, and namespace variables are added on top. Do not rely on that for isolation.
- **A bad value can take an app down:** the old process is stopped before the new one starts. If the new one never becomes healthy the entry still says `running`, so the reconciler retries on the following ticks.
- **Frontend apps:** a static bundle cannot read `process.env`. The planned way is for the generated `server.js` to serve a `/config.json` built at start from variables with a `PUBLIC_` prefix. Not built yet.
