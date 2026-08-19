# Clerk authentication — Infrastructure change-list (Terraform repo)

Replaces Google Identity Services with Clerk, and moves verification from the Lambda to an
API Gateway JWT authorizer. Like [users-table-infra.md](./users-table-infra.md), this
documents the work in the separate infrastructure (Terraform) repo, at
`projects/stagehopper/`. Apply it **together with** the app deploy that carries this change:
the client stops sending `googleIdToken` in request bodies and starts sending
`Authorization: Bearer`, and two routes change verb.

Design: `spacetraders/meta/docs/design/auth-design.md`, decisions 14–17.

Region: `eu-central-1`.

## 1. Clerk prerequisites (start these first — DNS has lead time)

A **production** Clerk instance is required before any of this can be applied, because the
authorizer's `issuer` is instance-specific.

1. **Custom domain + CNAMEs.** A production instance needs a custom domain
   (`clerk.stagehopper.radomskyi.com`). Its CNAME records belong in the Route53 zone this
   repo already manages. Propagation is documented as taking up to 48 hours.
2. **Your own Google OAuth credentials.** Production Clerk cannot use Clerk's shared Google
   OAuth client. **Reuse the Google Cloud OAuth client this app already has** — the one
   behind the retired `GOOGLE_CLIENT_ID` — rather than creating a second one; add Clerk's
   redirect URI to it. There is no reason for this app to own two Google clients.
3. **The `apigw` JWT template**, recreated on the production instance. It exists on
   development already (`jtmp_3I92r2IFaTud8D7DF04ka9O2PbH`); templates do not carry across
   instances. Claims:

   ```json
   {
     "aud": "stagehopper-api",
     "scope": "{{user.public_metadata.scope || 'user'}}",
     "name": "{{user.full_name || ''}}",
     "email": "{{user.primary_email_address || ''}}"
   }
   ```

   Lifetime 60s, clock skew 5s, RS256.

   **Why a template rather than the session token.** An API Gateway JWT authorizer requires
   an `audience`, and validates `aud` against it. Clerk's default session token carries
   `azp, exp, fva, iat, iss, jti, nbf, sid, sub, v, pla, fea, sts` — no `aud` at all. A
   template is therefore the only token shape the gateway will accept, not a preference.

   The fallbacks matter: an unset shortcode resolves to `null`, not an omitted claim, and
   `scope: null` is a claim the gateway has to reason about. `|| 'user'` keeps every token
   carrying a concrete, non-admin scope.
4. **Grant the admin scope**, per admin user, by setting `public_metadata` to
   `{ "scope": "admin" }`. This is the entire admin allowlist now; there is no
   `ADMIN_EMAILS` anywhere.
5. **Sign-up stays open.** This is a room-sharing app for friends — an invite-only instance
   breaks the product. That is the opposite of the sibling `spacetraders` tenant, and
   deliberately so.

## 2. New Terraform: the authorizer

`aws_apigatewayv2_authorizer.clerk` (`authorizer_type = "JWT"`,
`identity_sources = ["$request.header.Authorization"]`), with:

| Field | Value |
|---|---|
| `issuer` | `var.clerk_issuer` — the Clerk **Frontend API URL** |
| `audience` | `var.clerk_audience`, default `stagehopper-api` |

`clerk_issuer` has **no default**, on purpose. An empty or wrong issuer produces an
authorizer that trusts nothing (or the wrong tenant), which surfaces as a puzzling 401 on
every route rather than as an error; requiring it fails at plan time instead. Neither value
is secret — the issuer is a public URL, the audience a public string — so neither is marked
`sensitive` and neither needs `TF_VAR_*` handling. Pass it at apply:

```bash
terraform apply -var 'clerk_issuer=https://clerk.stagehopper.radomskyi.com'
```

API Gateway resolves the signing keys itself from
`<issuer>/.well-known/openid-configuration`. Nothing has to be told about JWKS.

## 3. Route changes

**21 routes, of which 20 are authorized.** `GET /rooms/{roomId}/selections` stays fully
public: a room id is a capability URL, holding the link *is* the authorization, and
requiring a session to read a room would break sharing one with a friend. That is now an
explicit choice rather than an artifact of where the code happened to check.

**10 routes additionally carry `authorization_scopes = ["admin"]`** — every `/admin/*` route
except `GET /admin/me`, which must stay reachable by a signed-in non-admin because telling
them "no" is the only thing it does. A gateway 403 cannot say that.

Verb changes (both replace the route, which Terraform handles):

| Was | Now | Why it was ever a POST |
|---|---|---|
| `POST /users/me/rooms` | `GET /users/me/rooms` | a body was the only place a credential could ride |
| `POST /admin/me` | `GET /admin/me` | same |

New route: **`GET /admin/festivals`** (admin-scoped). It could not exist before, because
`fetch` refuses to send a body on a GET, so the admin editor read the published list off
CloudFront and raced its own just-saved write.

The four notification routes keep their bodies and their verbs — they were never POSTs to
carry a token, but to carry a push `endpoint`, which is a long opaque URL that has no
business in a query string.

## 4. CORS

`allow_headers` gains `Authorization`. Without it the browser blocks every authenticated
request at preflight. Preflight itself is unaffected: API Gateway answers `OPTIONS` from
`cors_configuration` before authorization runs, so no `OPTIONS` route needs an authorizer.

## 5. Lambda environment

Remove **both** `GOOGLE_CLIENT_ID` and `ADMIN_EMAILS` from the `stagehopper` function, and
remove their `ignore_changes` entries at the same time — `ignore_changes` on a key *preserves*
it, so leaving those entries in place would leave the live values behind. The code that read
them is gone: `resolveGoogleIdentity`, `isAdminIdentity`, `extractGoogleIdToken` and the
`google-auth-library` dependency are all deleted, and the handler now reads
`event.requestContext.authorizer.jwt.claims.sub`, which API Gateway populates and a client
cannot forge.

The `email_verified === true` guard went with them. Its purpose was that an unverified
address is a string the account holder chose; a signed `scope` claim has no such weakness.

The notifier (`stagehopper-notifier`) needs no environment change.

## 6. Keyspace cutover

The participant key changes from `google:${sub}` to `clerk:${userId}`. It is the partition
key of `stagehopper-users`, the sort key of `stagehopper-selections`, and the partition key
of `stagehopper-push-subscriptions`.

**No table schema changes and no backfill code.** With two real users, the rows are simply
discarded, exactly as the users-table consolidation did. Drop and recreate the three tables
— or, since the schemas are identical either way, delete their items, which reaches the same
end state without disabling deletion protection on tables holding real data. Whichever you
pick, do it in the same window as the deploy: a `google:`-keyed row is unreachable
afterwards, and a returning user simply starts clean.

Both `stagehopper-selections` and `stagehopper-users` have
`deletion_protection_enabled = true`; dropping them via Terraform means an apply to disable
it, a `-replace`, and an apply to re-enable — and it discards their PITR history.

`stagehopper-notif-dedup` is also keyed on `userId`, but needs no attention: its rows are
TTL-reaped within hours, so stale `google:` markers expire on their own.

## 7. CI

`deploy.yml` (app repo) swaps `VITE_GOOGLE_CLIENT_ID` for `VITE_CLERK_PUBLISHABLE_KEY` at
build time. Publishable keys are public — the key names the instance, it authorizes nothing
— so this is not secret handling. `CLERK_SECRET_KEY` is never needed: the app is a
prerendered static site with no server.

## 8. Known rough edge, not addressed here

The CloudFront distribution rewrites **403** responses to `index.html` with a 200
(`custom_error_response`, which is distribution-wide and applies to `/api/*` too). A
non-admin hitting an admin route therefore sees a 200 of HTML rather than the gateway's 403,
and the client reports a generic failure instead of "not an admin".

This predates this change — the Lambda already returned 403 for non-admins — and it is not a
security hole: the gateway still refuses the request, and nothing privileged is served.
Fixing it properly means moving the SPA fallback off `custom_error_response` (a CloudFront
Function, or scoping the fallback away from `/api/*`), which is a separate change to make
deliberately rather than in passing.
