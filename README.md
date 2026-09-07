# NocoDB + Git snapshots on Render

This repository builds one Render-compatible container from the official
`nocodb/nocodb` image. It runs:

- NocoDB privately on `127.0.0.1:8080`;
- a tiny Node.js reverse proxy on Render's public `PORT`;
- authenticated Git save/status endpoints on a loopback-only port;
- a safe snapshot pipeline that restores `data/` on boot and commits it on demand.

No NocoDB source fork is required and the wrapper has no npm dependencies.

## Data flow

```text
Git remote:data/ -> boot restore -> /var/lib/nocodb-live -> NocoDB
NocoDB Button -> POST 127.0.0.1:9000/git-save -> SQLite backup -> Git remote:data/
```

NocoDB never runs directly against the versioned SQLite file. During save, the
wrapper uses SQLite's online `.backup` command, excludes `noco.db-wal` and
`noco.db-shm`, stages the complete app-data tree, and atomically replaces the
repository's `data/` directory before committing it.

## 1. Create the GitHub repository

Push this application repository to GitHub. The Git remote used for snapshots
can be either:

1. a separate private data repository (recommended); or
2. this same repository.

If you use the same repository and branch, every snapshot push can trigger a
new Render deploy. Disable Render Auto-Deploy, use a separate data repository,
or use a separate snapshot branch to avoid that loop.

Create a fine-grained GitHub personal access token restricted to the snapshot
repository, with **Contents: Read and write** permission. Do not put it in this
repository or in NocoDB.

## 2. Configure Render

Create a Web Service using this repository and select the Docker runtime. The
included `render.yaml` can also be used as a Blueprint.

Set these environment variables in Render:

| Name | Secret | Required | Meaning |
| --- | --- | --- | --- |
| `GIT_REMOTE_URL` | No | Yes | HTTPS Git URL, e.g. `https://github.com/OWNER/DATASET.git` |
| `GIT_TOKEN` | Yes | Yes | Fine-grained GitHub PAT with repository Contents read/write |
| `GIT_WEBHOOK_SECRET` | Yes | Yes | Long random value used by the NocoDB button's Bearer header |
| `NC_AUTH_JWT_SECRET` | Yes | Yes | Long, stable random value for NocoDB sessions |
| `GIT_BRANCH` | No | No | Snapshot branch; default `main` |
| `GIT_INTERNAL_PORT` | No | No | Loopback-only webhook port; default `9000` |
| `GIT_USERNAME` | No | No | HTTPS username; default `x-access-token` works with GitHub PATs |
| `GIT_AUTHOR_NAME` | No | No | Commit author name |
| `GIT_AUTHOR_EMAIL` | No | No | Commit author email |
| `NC_ADMIN_EMAIL` | No | No | Optional NocoDB administrator recovery email |
| `NC_ADMIN_PASSWORD` | Yes | No | Optional NocoDB administrator recovery password; set together with email |
| `NC_SITE_URL` | No | No | Public NocoDB URL; inferred from `RENDER_EXTERNAL_URL` when omitted |

`GITHUB_TOKEN` is accepted as a fallback alias for `GIT_TOKEN`.

The image already sets both:

```text
NC_WEBHOOK_ALLOW_PRIVATE_NETWORK=true
NC_ALLOW_LOCAL_HOOKS=true
```

The first is NocoDB's current variable name; the second is the compatible
legacy name. This is required because the NocoDB webhook calls the wrapper at a
loopback address in the same container.

Use exactly one Render instance. Multiple replicas can both start from the same
commit; conflict detection prevents overwrites, but the stale replica must be
restarted before it can save.

## 3. Configure the NocoDB Save Version button

After the first deployment:

1. Open NocoDB and create or select a small `Workspace` table.
2. Add a single-line text field named `CommitMessage`.
3. Open **Details -> Webhooks -> Add New Webhook**.
4. Choose **Manual Trigger / Button Trigger**.
5. Choose HTTP `POST` and URL:

   ```text
   http://127.0.0.1:9000/git-save
   ```

6. Add the header below. The value must exactly match Render's
   `GIT_WEBHOOK_SECRET`:

   ```text
   Authorization: Bearer YOUR_GIT_WEBHOOK_SECRET
   Content-Type: application/json
   ```

7. Use this custom payload:

   ```json
   {
     "message": "{{ event.data.rows.[0].CommitMessage }}"
   }
   ```

8. Create a **Button** field named `Save Version`, choose **Run Webhook**, and
   select the webhook.

If you do not need a custom message, use `{}` as the body. The wrapper generates
an ISO-timestamped message. A second click with no new data returns
`{"changed":false,"message":"Nothing to save"}` and creates no empty commit.

## Endpoints

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `GET /healthz` | None | Render health check; healthy only after NocoDB responds |
| `POST /git-save` | Bearer token | Snapshot, commit, and push `data/` |
| `GET /git-status` | Bearer token | Current local snapshot commit and lock state |
| everything else | NocoDB login | Reverse-proxied to NocoDB |

Example save test from a trusted terminal:

```bash
curl -fsS -X POST "https://YOUR-SERVICE.onrender.com/git-save" \
  -H "Authorization: Bearer $GIT_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"message":"finish annotations for batch 13"}'
```

## Conflict behavior

Before each save the wrapper fetches `origin/GIT_BRANCH` and requires the local
base commit to equal the remote commit. If another Render session or a human
has pushed first, it returns HTTP `409` without overwriting or merging the
database. Restart/redeploy the stale service to restore the latest `data/`.

Pushes never use `--force`. A process-local lock also returns HTTP `423` when a
save is already running.

## Important limits

- This MVP versions NocoDB's local SQLite/app-data directory. Do not set `NC_DB`
  to external PostgreSQL and assume the database itself is included.
- Render's filesystem is ephemeral by design; the Git remote is the durable
  source restored on container boot. A failed save leaves current edits in the
  running container only, so resolve the error before restarting it.
- SQLite files are binary and Git repositories grow over time. This design is
  appropriate for explicit dataset milestones, not per-cell commits.
- Avoid uploading attachments while a snapshot is running. The SQLite database
  is transactionally backed up; ordinary attachment files are copied at the
  filesystem level.
- Protect `GIT_WEBHOOK_SECRET`; anyone holding it can create a snapshot commit.

## Local checks

The wrapper tests require Node.js 20+ and Git; they use a fake SQLite command so
no local database package is needed:

```bash
npm test
```

To build the real image:

```bash
docker build -t nocodb-git-render .
```

## Relevant upstream documentation

- [NocoDB Button fields](https://nocodb.com/docs/product/tables/fields/field-types/custom-types/button)
- [NocoDB webhook configuration](https://nocodb.com/docs/product/tables/table-operations/webhook/create-webhook)
- [NocoDB self-hosted environment variables](https://nocodb.com/docs/self-hosting/environment-variables)
- [Render Docker services](https://render.com/docs/docker)
