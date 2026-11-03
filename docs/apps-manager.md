# Apps manager

The **My apps** button in the editor's header opens a list of published applications, with **Stop**, **Start** and **Delete** for each. It refreshes every 3 seconds while open.

| Column | Meaning |
|---|---|
| App | The app id. A link to the stable URL when the app is running and answering |
| AIT | The AIT the app was published under |
| Status | `running`, `starting`, `stopped`, `deleting` or `failed`. A `running` app that does not answer `/healthz` also shows **not answering** |
| Runs on | The VM and port from the registry |
| Release, Restarts | The release number, and how many times the reconciler had to recover the app |

The filter box shows only one AIT's apps. Empty shows all.

**There is no login yet, so "your apps" means "the apps of an AIT".** Anyone who can open the editor can stop or delete any app. Per-user ownership needs the OAuth work from version 2 of the notes.

## How it works

The builder that receives a click may run on a different VM from the app, and it cannot stop a process on another VM. So an action does not touch the process directly. It records what the user wants in `registry/<appId>.json`, and the **reconciler on the VM that owns the app** carries it out. When the app happens to run on the builder's own VM, the builder acts immediately.

| Action | Status written | Done by | What happens |
|---|---|---|---|
| **Stop** | `stopped` | The builder if the app is on its VM, otherwise the owning VM's reconciler (within one interval) | The process is stopped. The release stays, and the reconciler does **not** restart a stopped app. The stable URL answers 503 |
| **Start** | `starting` | The reconciler on the owning VM | Starts the app from its release, on its old port if free, waits for `/healthz`, then writes `running`. Not counted as a restart. If the release is missing or the app never answers, the status becomes `failed` |
| **Delete** | `deleting` | The builder if the app is on its VM, otherwise the owning VM's reconciler | Stops the process, deletes `apps/<ait>/<appId>/` (all releases) and the registry entry. The URL answers 404 afterwards |

If the owning VM is gone, the elected adopter (see `reconciler.md`) carries out `starting` and `deleting`. A stopped app on a lost VM has no process to stop, so it just stays `stopped`.

Start is only offered for `stopped` and `failed` apps, and Delete asks for confirmation in the browser.

## API

| Request | Result |
|---|---|
| `GET /api/apps` or `GET /api/apps?ait=<ait>` | `{ apps: [...] }` with each registry entry plus `url`, `directUrl` and `healthy` (a live `/healthz` check for running apps) |
| `POST /api/apps/<appId>` with `{ "action": "stop" }` or `{ "action": "start" }` | `{ ok: true }` |
| `DELETE /api/apps/<appId>` | `{ deleted: true }` when done now, `{ deleted: false }` when the owning VM's reconciler will finish it |

Errors: `400` for an invalid app id or unknown action, `404` for an unknown app, `409` for stopping or starting an app that is being deleted.

## Code

| What | Where |
|---|---|
| The panel | `src/components/AppsPanel.tsx`, opened from `src/components/Header.tsx` |
| List, stop, start, delete | `src/server/apps.ts` |
| API routes | `src/pages/api/apps/index.ts`, `src/pages/api/apps/[appId].ts` |
| Carrying out `stopped`, `starting`, `deleting` | `reconciler/server.js`, in `tick` |
| Safe process stop and app removal | `runtime/lifecycle.js`: `isAppProcess`, `stopApp`, `removeApp` |

### Safety

- **Pids are checked before they are signalled.** A pid in the registry can be reused by an unrelated process after the app dies. `stopApp` only signals a pid whose command line is `node server.js`. This applies to restarts and adoptions too. On a system without `/proc` (not Linux) there is nothing to check, so the registry is trusted there.
- **Ids are validated before any path is built.** App ids and AITs must match `[a-z0-9][a-z0-9-]{2,39}`, so a value like `../x` cannot reach the filesystem. `removeApp` checks again.

## Verified

- `src/server/apps.test.ts` (9 tests): listing with health and AIT filter; stopping an app on this VM versus another VM; unknown and invalid ids; starting; refusing a deleting app; deleting on this VM versus another VM.
- `npm run reconciler:test` (15 tests), including: a stopped app's process is stopped once and not restarted; a stopped or deleting app on another live VM is left alone; a deleted app loses its process, releases and registry entry; a started app is not counted as a restart; a non-app pid is never signalled; ids that could escape the shared directory are refused.
- End to end with two builders (one as `vm1`, one as `vm2`), the proxy and one reconciler for `vm1`:
  - Listing through `vm2` showed the app running and healthy; an AIT filter that matched nothing returned none.
  - Stop on `vm1` stopped the process at once; the URL then answered 502 for about a second (the proxy's registry cache) and 503 after that.
  - Start from `vm2` set `starting`, and about 2 seconds later the app answered at the same URL with `restarts` still 0.
  - Stop from `vm2` set `stopped` immediately, and the process was gone about 2 seconds later.
  - Delete from `vm2` returned `{ deleted: false }`; about 2 seconds later the registry entry and release folder were gone and the URL answered 404.
  - Unknown app returned 404, an invalid id 400, an unknown action 400.
- **Not tested:** the panel in a browser. The code compiles and the API it calls was exercised, but I have not clicked through it.

## Current limits

- **No users:** see above. Anything the editor can reach can be stopped or deleted.
- **Delay for other VMs:** an action on an app owned by another VM takes up to `RECONCILE_INTERVAL_MS` (5 s by default) to take effect. The list shows the requested status in the meantime.
- **Stopped means stopped for good:** an app stays stopped through reboots and VM loss until someone starts it.
- **`failed` needs a decision:** a failed app can be started again (which retries from its release) or deleted. If the release folder is gone, publish it again.
- **No undo for delete:** all releases are removed.
- **A race with publish:** publishing an app while it is being deleted is not guarded.
