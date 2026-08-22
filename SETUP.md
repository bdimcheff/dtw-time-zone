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

Then check the endpoints on the default domain, before DNS exists:

```sh
curl -sI https://dtw-time-zone.web.app/xrpc/app.bsky.feed.getFeedSkeleton | grep -i content-type
curl -s  https://dtw-time-zone.web.app/.well-known/did.json
```

`content-type` must be `application/json`. If it says `application/octet-stream`,
the `headers` block in `firebase.json` isn't matching. If `did.json` 404s, the
`ignore` list has regained a `**/.*` glob and is excluding `.well-known`.

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
Certificate provisioning is the slow step.

## 3. Deploy service account

```sh
gcloud config set project dtw-time-zone

gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions deploy"

gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/firebasehosting.admin"

gcloud projects add-iam-policy-binding dtw-time-zone \
  --member="serviceAccount:github-deploy@dtw-time-zone.iam.gserviceaccount.com" \
  --role="roles/firebase.viewer"

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
