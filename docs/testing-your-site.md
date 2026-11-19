# Testing your site with a Personal Agent

You have added Poppy to your site, or you are about to. This is how you find out whether an agent
can actually use it, before an agent shows up and quietly fails.

There are two checks, and they answer different questions. Run both.

| Check                                          | Answers                               | Needs                                   |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------- |
| `npx @descope/poppy-conformance site <domain>` | Do my documents say the right things? | Nothing. Read-only, safe on production. |
| `node examples/site-agent.ts <domain>`         | Can a real agent actually get in?     | An agent identity, and you at a phone.  |

The first reads every document in the discovery chain and reports which rule each one breaks. The
second signs in as you and browses, which is the part no document check can tell you: the issuer may
refuse the agent, the scope may not be grantable, the browser-join endpoint may 404, the session
cookie may never arrive.

A site can pass the first and fail the second. Start with the first anyway — a failure there
explains a failure in the second, and the second stops at the first step it can't get past.

## 1. What your site publishes

### `/.well-known/poppy.json`

The minimum for a site that wants agents to browse it and sign in, and nothing more — no APIs, no
Company Agent:

```json
{
  "protocol_version": "0.4",
  "organization": {
    "name": "Example Corp",
    "domain": "example.com"
  },
  "auth": {
    "issuer": "https://issuer.example.net/v1/apps/YOUR_APP",
    "scopes": {
      "poppy:browser-sign-in": "Sign in to example.com as you, so the agent sees your account"
    },
    "scope_hints": {
      "poppy:browser-sign-in": { "changes": "none", "personal_data": true }
    }
  },
  "web": {
    "browser_session_endpoint": "https://example.com/poppy/browser-session"
  }
}
```

Three things about this document are easy to get wrong:

- **`organization.domain` must equal the host that served it, after redirects.** If `example.com`
  redirects to `www.example.com`, the document served at the end of that redirect must say
  `www.example.com`. This is what stops someone uploading a file that speaks for your domain.
- **It must list at least one of `agent`, `apis` or `web`.** A document with none of them describes
  a company that offers agents nothing, and is refused rather than read as "browse only". `web` is
  what says "browse the site".
- **Listing `browser_session_endpoint` is a promise.** Once it is there, an agent must join its
  browser to a session before browsing. If the URL doesn't answer, agents that could browse your
  site before now can't. Add the field in the same deploy as the route.

### `/.well-known/oauth-protected-resource`

This is where an agent learns who signs your users in:

```json
{
  "resource": "https://example.com",
  "authorization_servers": ["https://issuer.example.net/v1/apps/YOUR_APP"],
  "scopes_supported": ["poppy:browser-sign-in"]
}
```

`resource` must be exactly your origin — scheme and host, no path, no trailing slash.

### Your issuer has to name you back

The link is two-way on purpose: your site names an issuer, and the issuer's metadata must list your
origin in `protected_resources`. Neither side can claim the other alone.

```json
"protected_resources": ["https://example.com"]
```

It is matched as a bare origin. `https://example.com/` with a trailing slash, `https://example.com:443`
with a port, or a path like `https://example.com/api` will not match, and discovery fails with
`protected_resources does not list https://example.com`.

#### If your issuer is Descope

Two details cost people an afternoon each.

**Use the Inbound App issuer, not the project issuer.** Poppy follows RFC 8414, which puts
`.well-known/oauth-authorization-server` _between the host and the path_:

| Issuer                                | Metadata is fetched from                                                     | Works |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----- |
| `https://api.descope.com/PROJECT`     | `https://api.descope.com/.well-known/oauth-authorization-server/PROJECT`     | No    |
| `https://api.descope.com/v1/apps/APP` | `https://api.descope.com/.well-known/oauth-authorization-server/v1/apps/APP` | Yes   |

The project issuer publishes its metadata at the OpenID Connect suffix path
(`/PROJECT/.well-known/openid-configuration`) instead, and the RFC 8414 path for it returns a
_different_ issuer's document — so discovery fails on the mismatch rather than on a 404, which is
harder to read. The Inbound App issuer is also the one that carries `protected_resources`.

**Your issuer needs the device grant.** `grant_types_supported` must include `refresh_token`, and
`urn:ietf:params:oauth:grant-type:device_code` for the sign-in flow below. Descope's Inbound Apps
have both.

## 2. Signing in, so the agent can use your web functions

Browsing signed out gets an agent your catalog and your help pages. For anything behind a login —
an order, a booking, an account — the agent needs to become the user in a browser. That is the
browser join, and it is three requests:

1. The agent opens `web.browser_session_endpoint` in its own browser. Your page returns a one-time
   code in a hidden `code` field, and a cookie tying that code to that browser.
2. The agent POSTs `{"code": "..."}` to `<endpoint>/authorize` with its session header and access
   token. You match the code to the token and remember the account.
3. The agent submits the page's form back to `<endpoint>/submit`, with the cookie from step 1. You
   set your normal session cookie, and the browser is signed in from then on.

The cookie in step 1 is what stops a code stolen from the page being redeemed by a different
browser, so the page must set it and `/submit` must require it.

A signed-in join needs the `poppy:browser-sign-in` scope. Without it, answer `insufficient_scope`
and the agent will join signed out instead — which is a working outcome, not a failure.

## 3. Give the agent an identity

An agent's `client_id` is an HTTPS URL that your issuer fetches, not a string from a registration
form. That is what lets an agent reach a company it has never met. It also means there is nothing to
run until that URL answers:

```bash
node examples/agent-identity.ts --client-id https://your-host/poppy-agent.json
```

That writes three files. Serve `agent.json` at exactly the `--client-id` URL and `agent-jwks.json`
at the `jwks_uri` inside it — both static, both public, and both on the same host. Keep
`private-key.jwk`.

If you are testing someone else's site rather than your own, this identity is yours as the agent
author, and you publish it once and reuse it.

## 4. Run the checks

```bash
npx @descope/poppy-conformance site example.com
```

```
example.com — 25 checks, 0 failing (0 MUST)
```

Neither package is on npm yet. Until they are, clone
[poppy-conformance](https://github.com/descope/poppy-conformance) and run
`node src/cli.ts site example.com`, and run `site-agent.ts` from a clone of this repository.

Then the live run:

```bash
export AGENT_CLIENT_ID=https://your-host/poppy-agent.json
export AGENT_KEY_JWK="$(cat poppy-agent-identity/private-key.jwk)"
node examples/site-agent.ts example.com
```

```
example.com

  ✓ discovery              Example Corp — Poppy 0.4
  ✓ surfaces               website
  ✓ sign-in                device, direct — issuer https://issuer.example.net/v1/apps/YOUR_APP
  ✓ scopes                 openid, profile, email, poppy:browser-sign-in
  ✓ browser join           https://example.com/poppy/browser-session

  Approve Example Corp (example.com) for: poppy:browser-sign-in
  Open https://issuer.example.net/device?user_code=ABCD-EFGH
  Waiting…

  ✓ signed in              granted poppy:browser-sign-in
  ✓ join: page             a one-time code and its cookie
  ✓ join: authorized       signed in with poppy:browser-sign-in
  ✓ join: submit           → 302, set __Host-session
  ✓ page fetch             https://example.com/ → 200

Every step an agent takes against this site worked.
```

Add `--signed-out` to check the browser join works before any account exists, `--scope` to ask for
something other than the default, and `--page` to fetch something other than the root.

Both commands exit 1 when something failed and 2 when you typed the command wrong, so either can
gate a deploy.

## When it fails

| What you see                                                     | What it means                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `poppy.json must list at least one of agent, apis, or web`       | The document describes no surface. Add `"web": {}` for a site agents may browse.                 |
| `organization.domain ... does not match the host that served it` | A redirect moved the document. Serve it on the host the document names.                          |
| `protected_resources does not list https://example.com`          | The issuer doesn't name you back. Bare origin, no path, no port, no trailing slash.              |
| `OAuth metadata issuer does not match the Company's issuer`      | Your `auth.issuer` resolves to someone else's metadata. See the Descope note above.              |
| `auth.issuer must name the domain's authorization server`        | `auth.issuer` and the PRM's `authorization_servers` disagree, character for character.           |
| `the domain lists several issuers, so auth.issuer is required`   | Pick one in `poppy.json`.                                                                        |
| `Third party application not found` at sign-in                   | Your issuer couldn't fetch the agent's `client_id`. Check the URL answers, unredirected.         |
| `no web.browser_session_endpoint`                                | The site lists no way to sign a browser in, so agents browse signed out only.                    |
| `join: submit → 200, but no cookie was set`                      | `/submit` accepted the code without starting a session. The browser is still a stranger.         |
| `... is not an API or endpoint ... lists`                        | The agent tried a URL your documents never vouched for. List the API, or point it at one listed. |
