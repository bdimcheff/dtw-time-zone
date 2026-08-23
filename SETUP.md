# Setup via CLI

Every step below is scriptable. The one thing the `firebase` CLI cannot do is add a
custom domain — `firebase-tools` 15.x has `hosting:sites:*` but no domain command —
so that step uses the Hosting REST API directly instead of the console.

Assumes `firebase`, `gcloud`, and `gh` are available. Prefix with `, ` if a binary
isn't installed locally.

## 0. Confirm state

```sh
firebase login                                    # if not already
firebase projects:list
firebase hosting:sites:list --project dtw-time-zone
```

Expect project `dtw-time-zone` and a site of the same name serving
`https://dtw-time-zone.web.app`. No Firebase "app" registration is needed; Hosting
doesn't use one.

## 1. Deploy

```sh
npm run build
firebase deploy --only hosting --project dtw-time-zone
```

`getFeedSkeleton` is a Cloud Function, not a static file, so it needs §3 first and
then:

```sh
npm run build:functions
firebase deploy --only functions:getFeedSkeleton --project dtw-time-zone
```

Then check the endpoints on the default domain, before DNS exists:

```sh
curl -sI https://dtw-time-zone.web.app/xrpc/app.bsky.feed.describeFeedGenerator | grep -i content-type
curl -s  https://dtw-time-zone.web.app/.well-known/did.json
```

`content-type` must be `application/json`. For `describeFeedGenerator` that comes
from the `headers` block in `firebase.json`; if it says `application/octet-stream`,
that block isn't matching. The skeleton sets its own content type in
`src/functions/index.ts`, so the `headers` block is not the thing to check there —
and it must *not* be widened back to `/xrpc/**`, because header rules are applied
before rewrites and would override the function's own headers.

If `did.json` 404s, the `ignore` list has regained a `**/.*` glob and is excluding
`.well-known`.

## 2. Custom domain

Needs an OAuth token. Either authenticate gcloud:

```sh
gcloud auth login
TOKEN=$(gcloud auth print-access-token)
```

or reuse the token the Firebase CLI already holds:

```sh
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/configstore/firebase-tools.json')))['tokens']['access_token'])")
```

Create the custom domain:

```sh
SITE=projects/dtw-time-zone/sites/dtw-time-zone

curl -s -X POST \
  "https://firebasehosting.googleapis.com/v1beta1/${SITE}/customDomains?customDomainId=dtw.dimcheff.wtf" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-goog-user-project: dtw-time-zone" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

The `x-goog-user-project` header is required with user credentials from
`gcloud auth print-access-token`; without it the API returns 403 asking for a
quota project.

**This domain has already been created.** It asked for a single record — a CNAME,
not the A records the older `brandon.dimcheff.com` uses:

| Type | Host | Answer |
|---|---|---|
| `CNAME` | `dtw` | `dtw-time-zone.web.app` |

Add it at **Porkbun** (`dimcheff.wtf` lives there; `dimcheff.com` is on Google Cloud
DNS). Porkbun's Host field takes only the subdomain part. No TXT record is needed —
ownership is proven by the CNAME itself.

Poll until ownership and host go active:

```sh
curl -s "https://firebasehosting.googleapis.com/v1beta1/${SITE}/customDomains/dtw.dimcheff.wtf" \
  -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: dtw-time-zone" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ownership:', d.get('ownershipState'), '| host:', d.get('hostState'), '| cert:', (d.get('cert') or {}).get('state'))
for grp in (d.get('requiredDnsUpdates') or {}).get('desired') or []:
    for r in grp.get('records') or []:
        print(f\"  {r.get('type'):6s} {r.get('rdata')} ({r.get('requiredAction')})\")
for i in d.get('issues') or []:
    print('issue:', (i.get('detail') or '')[:200])
"
```

Target state is `OWNERSHIP_ACTIVE` / `HOST_ACTIVE` with a cert in `CERT_ACTIVE`.

### Certificate stuck in CERT_VALIDATING

Ownership and host can both go active within a minute while the certificate sits in
`CERT_VALIDATING` indefinitely. Firebase offers two ACME challenges, and the HTTP
one cannot complete on a fresh domain: requesting the challenge path over HTTP
returns a 301 to HTTPS, which fails because the certificate being validated doesn't
exist yet.

Resolve it with the DNS challenge instead. The record is in the same GET response:

```sh
curl -s "https://firebasehosting.googleapis.com/v1beta1/${SITE}/customDomains/dtw.dimcheff.wtf" \
  -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: dtw-time-zone" \
  | python3 -c "
import json,sys
c=json.load(sys.stdin).get('cert') or {}
for ch in (c.get('verification',{}).get('dns',{}) or {}).get('desired') or []:
    for r in ch.get('records') or []:
        print(r.get('type'), r.get('domainName'), '->', r.get('rdata'), f\"({r.get('requiredAction')})\")
"
```

Add the resulting `TXT` at `_acme-challenge.dtw` alongside the CNAME. Both records
stay; the CNAME routes traffic, the TXT proves control for the certificate.

## 3. Deploy service account and function IAM

Verified against a real deploy. Four rounds of trial and error produced this; the
ordering comments are the part that matters.

```sh
gcloud config set project dtw-time-zone

gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions deploy"

gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/firebasehosting.admin"
```

That is all a hosting-only deploy needs. (`roles/firebase.viewer` used to be listed
here; it was never actually granted, and isn't needed — `firebasehosting.admin`
already carries `firebase.projects.get`.)

The feed function needs the rest of this section.

### APIs

The deploy SA deliberately cannot enable APIs — `serviceusage.serviceUsageAdmin` on
a CI credential is a bigger grant than this project wants — so enable them as owner
first. `firebaseextensions` and `cloudbilling` are checked even by an
`--only functions:` deploy. `compute` is *not* required.

```sh
gcloud services enable \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com \
  firebaseextensions.googleapis.com cloudbilling.googleapis.com \
  --project dtw-time-zone
```

### Runtime service account

The function reads a bundled file and returns JSON, so it needs no project
permissions at all. It gets its own identity rather than inheriting the Compute
Engine default, which arrives holding `roles/editor`.

```sh
gcloud iam service-accounts create feed-fn-runtime \
  --display-name="getFeedSkeleton runtime (no permissions by design)" \
  --project dtw-time-zone

# The one exception: without this its logs never reach Cloud Logging, and this
# feed's failure mode is silence.
gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:feed-fn-runtime@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/logging.logWriter"
```

It is pinned in `src/functions/index.ts` via the `serviceAccount` option.

### Deploy service account roles

```sh
# cloudfunctions.admin, NOT .developer. Only .admin carries
# cloudfunctions.functions.setIamPolicy and run.services.setIamPolicy. Without the
# first, deploy fails pre-flight; without the second it deploys and then every
# request through the rewrite returns 403, because the allUsers invoker binding
# never gets set.
gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/cloudfunctions.admin"

# firebase-tools sends x-goog-user-project on Service Usage calls, which needs
# serviceusage.services.use. cloudfunctions.admin has only .get.
gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer"

gcloud iam service-accounts add-iam-policy-binding \
  feed-fn-runtime@dtw-time-zone.iam.gserviceaccount.com \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" --project dtw-time-zone
```

### The two default service accounts

Enabling `cloudbuild` provisions `<project>@appspot` and `<number>-compute`, **both
holding `roles/editor`**, and firebase-tools demands `actAs` on both: it probes
appspot before doing anything, and the Cloud Functions API itself requires actAs on
compute, which is the gen2 *build* identity — separate from the runtime SA, and not
overridable, because `firebase-functions` exposes no build-service-account option.

Granting `actAs` on an Editor-holding account would hand the deploy key project
Editor, which defeats the dedicated runtime SA entirely. So strip Editor first. Per
account: give it what it actually needs, remove Editor, then grant `actAs` — so
there is never a window where builds lack permissions or the key holds Editor.

```sh
# appspot needs nothing: no App Engine app, no gen1 functions, nothing acts as it.
gcloud projects remove-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:dtw-time-zone@appspot.gserviceaccount.com" \
  --role="roles/editor"

gcloud iam service-accounts add-iam-policy-binding \
  dtw-time-zone@appspot.gserviceaccount.com \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" --project dtw-time-zone

# compute DOES work -- it runs the build -- so give it a real role first.
# cloudbuild.builds.builder covers exactly that: artifactregistry upload,
# storage.objects.*, logging.logEntries.create, cloudbuild.builds.*.
gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:1025302543904-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"

gcloud projects remove-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:1025302543904-compute@developer.gserviceaccount.com" \
  --role="roles/editor"

gcloud iam service-accounts add-iam-policy-binding \
  1025302543904-compute@developer.gserviceaccount.com \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser" --project dtw-time-zone
```

The project ends with **no Editor-privileged default service account**, which is a
better posture than a stock project starts in.

Do not grant `run.admin`, `artifactregistry.writer`, `cloudbuild.builds.editor`,
`cloudfunctions.developer`, or `serviceusage.serviceUsageAdmin` — each is either
redundant or insufficient here.

### Artifact Registry cleanup policy

Run **after** the first successful deploy: the `gcf-artifacts` repository does not
exist until a deploy creates it. A gen2 Node image is ~100-300 MB against a 500 MB
free tier, so this is the one line standing between this project and a bill.

```sh
firebase functions:artifacts:setpolicy --project dtw-time-zone --location us-central1
```

The workflows pass `--force`, which sets the policy automatically and keeps a
missing policy from failing a deploy that otherwise succeeded.

### Key

```sh
gcloud iam service-accounts keys create /tmp/dtw-deploy-key.json \
  --iam-account=github-deploy@dtw-time-zone.iam.gserviceaccount.com
```

## 4. GitHub secrets

```sh
gh secret set FIREBASE_SERVICE_ACCOUNT < /tmp/dtw-deploy-key.json
gh secret set BSKY_IDENTIFIER   --body "dimcheff.wtf"
gh secret set BSKY_APP_PASSWORD --body "xxxx-xxxx-xxxx-xxxx"

rm /tmp/dtw-deploy-key.json      # the key is now only in GitHub
```

## 5. Publish the feed record

Only after `dtw.dimcheff.wtf` resolves — the record is inert otherwise, and
`publish-record` refuses to run until it does.

```sh
npm run verify

BSKY_IDENTIFIER=dimcheff.wtf BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  npm run publish-record
```

`verify` walks the skeleton's cursor to exhaustion and compares it against
`data/posts.json`, so it fails if the function is serving a stale archive — which is
what happens if hosting was deployed without redeploying the function.
