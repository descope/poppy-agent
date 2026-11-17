/**
 * Company-side conformance: checks a real site's discovery chain.
 *
 * The rest of this module points the other way. `company.ts` is a strict Company at `shop.test`
 * that holds a Personal Agent to the spec. Nothing here held a *Company* to it, so a site could
 * publish a chain no agent can follow and find out only when agents quietly stopped arriving.
 *
 * This walks the chain an agent walks, in the order an agent walks it, and reports where it
 * breaks. Every result cites the rule it enforces, because a failure is only actionable if the
 * reader can look it up.
 *
 * Read-only: it GETs public metadata documents and nothing else. No tokens, no sign-in, no
 * writes — safe to point at a production domain.
 */

import { DEVICE_CODE_GRANT, SUPPORTED_PROTOCOL_VERSIONS } from "../discovery.ts";
import {
  authorizationServerMetadataUrl,
  httpsUrl,
  originOf,
  resourceMetadataUrl,
  withoutTrailingSlashes,
} from "../http.ts";
import { openApiServer } from "../resources.ts";
import type { Level } from "./checks.ts";

/** One rule, checked against one site. */
export interface SiteResult {
  /** Stable for fixed rules; suffixed with the subject for per-API and per-extension ones. */
  id: string;
  level: Level;
  /** The Poppy section, or the RFC clause when the rule is OAuth's rather than Poppy's. */
  cite: string;
  ok: boolean;
  /** What was found, in enough detail to act on without re-running the check by hand. */
  detail: string;
}

export interface SiteCheckOptions {
  fetch?: typeof fetch;
  /** Per-request timeout. A slow site is a finding, not a reason to hang. */
  timeoutMs?: number;
}

const WELL_KNOWN = "/.well-known/poppy.json";
const PRM = "/.well-known/oauth-protected-resource";
/** The newest version this SDK implements, which is the one an agent prefers (spec 3.4). */
const NEWEST_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0] ?? "0.4";
/** Plain names the protocol itself defines and this SDK reads (spec 3.3). */
const PROTOCOL_EXTENSIONS = new Set(["operations", "mediated-sign-in", "ucp"]);

interface Ctx {
  results: SiteResult[];
  fetch: typeof fetch;
  timeoutMs: number;
}

function add(
  ctx: Ctx,
  id: string,
  level: Level,
  cite: string,
  ok: boolean,
  detail: string,
): boolean {
  ctx.results.push({ id, level, cite, ok, detail });
  return ok;
}

interface Fetched {
  status: number;
  json?: Record<string, unknown> | undefined;
  /** The raw body, for the OpenAPI descriptions that are YAML rather than JSON. */
  text?: string;
  finalUrl: string;
  error?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * One line a reader can act on. A transport failure prints the reason rather than `→ 0`, and a
 * body that parsed as something other than a JSON object says so rather than printing a bare 200.
 */
function outcome(url: string | URL, fetched: Fetched): string {
  if (fetched.error !== undefined) return `${String(url)} → fetch failed: ${fetched.error}`;
  const hint = fetched.json === undefined ? " (not a JSON object)" : "";
  return `${String(url)} → ${fetched.status}${hint}`;
}

/**
 * A URL the SDK would accept, or undefined. Every URL here comes out of a document the Company
 * controls, so a malformed one is a finding to report, never a `TypeError` that throws away the
 * results gathered so far (the whole point of this tool is a report for a misconfigured site).
 */
function httpsOrUndefined(value: string): URL | undefined {
  try {
    return httpsUrl(value, "url");
  } catch {
    return undefined;
  }
}

/** A GET that never throws: a transport failure is a finding, not a crash. */
async function get(ctx: Ctx, url: string | URL): Promise<Fetched> {
  const target = String(url);
  try {
    const response = await ctx.fetch(target, {
      redirect: "follow",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    const text = await response.text();
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) json = parsed;
    } catch {
      // A body that isn't a JSON object is reported by whichever check needed one.
    }
    return { status: response.status, json, text, finalUrl: response.url || target };
  } catch (error) {
    return {
      status: 0,
      finalUrl: target,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

/**
 * Checks the discovery chain a Personal Agent follows for one Company, from its poppy.json to
 * the metadata of every API it advertises.
 *
 * @param input A domain (`example.com`) or an origin (`https://example.com`).
 * @returns Every rule checked, in the order an agent would reach it. Failures carry the detail
 *   needed to fix them; the caller decides what to do with the levels.
 */
export async function checkSite(
  input: string,
  options: SiteCheckOptions = {},
): Promise<SiteResult[]> {
  const ctx: Ctx = {
    results: [],
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
  };
  let origin: string;
  try {
    origin = /^https?:\/\//.test(input)
      ? new URL(input).origin
      : originOf(new URL(`https://${input}`).host);
  } catch {
    add(ctx, "input.site", "MUST", "3.1", false, `${input} is not a domain or an origin`);
    return ctx.results;
  }

  // ---- the discovery document ---------------------------------------------------------------
  const discovery = await get(ctx, `${origin}${WELL_KNOWN}`);
  const servedDocument = add(
    ctx,
    "discovery.document",
    "MUST",
    "3.1",
    discovery.status === 200 && discovery.json !== undefined,
    outcome(`${origin}${WELL_KNOWN}`, discovery),
  );
  if (!servedDocument || discovery.json === undefined) return ctx.results;
  const doc = discovery.json;

  // Redirects MAY cross hosts, but the document speaks only for the host that finally served it,
  // at exactly this path with no query. Otherwise anything able to serve a file from some path
  // could redirect to it and speak for the whole domain.
  const final = new URL(discovery.finalUrl);
  add(
    ctx,
    "discovery.well-known-path",
    "MUST",
    "3.1",
    final.pathname === WELL_KNOWN && final.search === "",
    `served from ${discovery.finalUrl}`,
  );

  const version = typeof doc["protocol_version"] === "string" ? doc["protocol_version"] : "";
  add(
    ctx,
    "discovery.version",
    "MUST",
    "3.1",
    /^\d+\.\d+$/.test(version),
    version ? `protocol_version: ${version}` : "protocol_version missing or not a string",
  );
  // An agent takes the newest version it implements, from this document or from one that
  // `supported_versions` links on the host that served this one (spec 3.4). So a version this SDK
  // doesn't implement is only a failure when no link offers one that it does.
  const linked = isObject(doc["supported_versions"]) ? doc["supported_versions"] : {};
  const onServingHost = (url: unknown): boolean => {
    if (typeof url !== "string") return false;
    try {
      const parsed = new URL(url, final);
      return parsed.protocol === "https:" && parsed.host.toLowerCase() === final.host.toLowerCase();
    } catch {
      return false;
    }
  };
  // `discover()` fetches a linked document and drops the version when it doesn't check out, so a
  // link that 404s, isn't JSON, or disagrees about its own version is no version at all. Only the
  // ones this SDK could choose are worth a request.
  const reachable: string[] = [];
  for (const [listed, url] of Object.entries(linked)) {
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(listed) || !onServingHost(url)) continue;
    const target = new URL(String(url), final);
    const document = await get(ctx, target);
    if (
      document.status === 200 &&
      // `fetchLinkedDocument` passes `followRedirects: false` and throws on any 3xx.
      document.finalUrl === target.href &&
      document.json !== undefined &&
      document.json["protocol_version"] === listed &&
      document.json["supported_versions"] === undefined
    )
      reachable.push(listed);
  }
  const offered = [version, ...reachable];
  const choosable = offered.filter((listed) => SUPPORTED_PROTOCOL_VERSIONS.includes(listed));
  add(
    ctx,
    "discovery.version-supported",
    "MUST",
    "3.4",
    choosable.length > 0,
    choosable.length > 0
      ? `an agent can speak ${choosable.join(", ")}`
      : `offers ${offered.filter(Boolean).join(", ") || "(nothing)"} — this SDK speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
  );
  add(
    ctx,
    "discovery.version-current",
    "SHOULD",
    "3.4",
    choosable.includes(NEWEST_VERSION),
    choosable.includes(NEWEST_VERSION)
      ? "current"
      : `${version || "(none)"} — agents prefer ${NEWEST_VERSION}, which this site doesn't offer`,
  );

  const organization = isObject(doc["organization"]) ? doc["organization"] : {};
  const domain = typeof organization["domain"] === "string" ? organization["domain"] : "";
  add(
    ctx,
    "discovery.domain",
    "MUST",
    "3.1",
    domain.toLowerCase() === final.host.toLowerCase(),
    `organization.domain ${domain || "(missing)"} vs serving host ${final.host}`,
  );
  const name = typeof organization["name"] === "string" ? organization["name"] : "";
  add(
    ctx,
    "discovery.organization-name",
    "SHOULD",
    "3.1",
    name !== "",
    name ? `name: ${name}` : "organization.name missing — agents show this to the user",
  );

  const surfaces = ["agent", "apis", "web"].filter((key) => doc[key] !== undefined);
  add(
    ctx,
    "discovery.surface",
    "MUST",
    "3.1",
    surfaces.length > 0,
    surfaces.length > 0 ? `has: ${surfaces.join(", ")}` : "none of agent, apis or web",
  );

  const auth = isObject(doc["auth"]) ? doc["auth"] : {};
  // Removed after 0.1. Device Sign-In is advertised through the issuer's grant_types_supported,
  // so a document still carrying this describes sign-in in a place agents no longer read.
  add(
    ctx,
    "discovery.no-auth-device",
    "MUST",
    "3.1",
    auth["device"] === undefined,
    auth["device"] === undefined ? "absent" : "auth.device is present — removed after 0.1",
  );
  // `auth.disabled` is the Company saying it offers Personal Agents no sign-in at all, even
  // though it has an issuer (3.2) — `PoppyUser` refuses to start one (`account.ts`). Nothing
  // that depends on a User signing in applies to such a Company, here or at the Session rule
  // below, so both ask this first. GoFundMe publishes exactly this shape.
  const signInDisabled = auth["disabled"] === true;

  const scopes = isObject(auth["scopes"]) ? auth["scopes"] : undefined;
  const described = scopes !== undefined && Object.keys(scopes).length > 0;
  add(
    ctx,
    "discovery.scopes-described",
    "SHOULD",
    "4.7",
    signInDisabled || described,
    signInDisabled
      ? "auth.disabled — no sign-in is offered, so there are no scopes to describe"
      : described
        ? `${Object.keys(scopes).length} described`
        : "auth.scopes absent — the user reads these when approving",
  );

  // Plain names are reserved for the protocol, which defines the few in PROTOCOL_EXTENSIONS;
  // anyone else prefixes with a domain they own. From 0.4 an entry is a list with one object per
  // major version, while 0.3 spells the same thing as a single object, and `parseExtensions`
  // still reads it that way — so the shape to require depends on the version.
  const extensions = isObject(doc["extensions"]) ? doc["extensions"] : {};
  const wantsList = version !== "0.3";
  for (const [extension, entry] of Object.entries(extensions)) {
    const prefixed = extension.includes("/");
    const reserved = PROTOCOL_EXTENSIONS.has(extension);
    add(
      ctx,
      `extensions.name:${extension}`,
      "MUST",
      "3.3",
      prefixed || reserved,
      prefixed
        ? `${extension} is domain-prefixed`
        : reserved
          ? `${extension} is defined by the protocol`
          : `${extension} has no domain prefix — plain names are reserved for the protocol`,
    );
    const shaped = wantsList ? Array.isArray(entry) : isObject(entry);
    add(
      ctx,
      `extensions.entries:${extension}`,
      "MUST",
      "3.3",
      shaped,
      shaped
        ? wantsList
          ? `${(entry as unknown[]).length} version ${(entry as unknown[]).length === 1 ? "entry" : "entries"}`
          : "one entry, as 0.3 spells it"
        : wantsList
          ? "not a list of per-version entries"
          : "not an entry object — 0.3 maps a name to one entry",
    );
  }

  // ---- the domain's own protected resource metadata ------------------------------------------
  // Everything from here is keyed to the host that FINALLY served poppy.json, because that is the
  // domain the document speaks for and the one `discover()` carries into the issuer lookup. Using
  // the host that was asked would give a site redirecting apex → www a MUST failure for a chain
  // that is set up correctly, and would check a PRM no agent ever reads.
  const resourceOrigin = originOf(final.host);
  const declaredIssuer = typeof auth["issuer"] === "string" ? auth["issuer"] : "";
  const domainPrm = await get(ctx, `${resourceOrigin}${PRM}`);
  const servedDomainPrm = add(
    ctx,
    "prm.domain",
    "MUST",
    "3.2",
    domainPrm.status === 200 && domainPrm.json !== undefined,
    `${outcome(`${resourceOrigin}${PRM}`, domainPrm)}${
      domainPrm.status === 404 ? ' (an agent reads this as "no issuer")' : ""
    }`,
  );

  let authorizationServers: string[] = [];
  if (servedDomainPrm && domainPrm.json !== undefined) {
    // Exactly the origin: lowercased host, no path, no trailing slash. A path here tells agents
    // every token must be scoped to that path, which is a different claim entirely.
    add(
      ctx,
      "prm.domain-resource",
      "MUST",
      "3.2",
      domainPrm.json["resource"] === resourceOrigin,
      `resource: ${String(domainPrm.json["resource"])} (expected ${resourceOrigin})`,
    );
    authorizationServers = strings(domainPrm.json["authorization_servers"]);
    // `findIssuer` takes the single listed server when `auth.issuer` is absent, but refuses to
    // guess between several. So silence is fine with one server and a failure with more.
    const namesIssuer =
      declaredIssuer === ""
        ? authorizationServers.length <= 1
        : authorizationServers.includes(declaredIssuer);
    add(
      ctx,
      "prm.domain-names-issuer",
      "MUST",
      "3.1",
      namesIssuer,
      declaredIssuer === ""
        ? authorizationServers.length <= 1
          ? "auth.issuer absent, which is allowed when the metadata names one server"
          : `authorization_servers lists ${authorizationServers.length} servers, so auth.issuer is required`
        : `authorization_servers ${
            authorizationServers.includes(declaredIssuer) ? "includes" : "does NOT include"
          } ${declaredIssuer}`,
    );
  }

  // ---- the issuer's side of the same link ----------------------------------------------------
  const issuer = declaredIssuer || authorizationServers[0] || "";
  const issuerUrl = issuer === "" ? undefined : httpsOrUndefined(issuer);
  if (issuer !== "" && issuerUrl === undefined) {
    add(
      ctx,
      "issuer.url",
      "MUST",
      "3.2",
      false,
      `${issuer} is not an https URL — agents reject the Company before any sign-in`,
    );
  } else if (issuerUrl !== undefined) {
    // RFC 8414 puts the well-known segment between origin and path, which matters because most
    // hosted issuers live under one.
    const specPath = authorizationServerMetadataUrl(issuer);
    let issuerMeta = await get(ctx, specPath);
    let issuerMetaUrl = String(specPath);
    let atOpenIdOnly = false;
    if (issuerMeta.status !== 200 || issuerMeta.json === undefined) {
      // OpenID Connect Discovery's suffix form is widely served, so look there before giving up —
      // but it is a finding, not a pass: `fetchOAuthServer` fetches only the RFC 8414 URL, so an
      // issuer answering solely here is one every agent built on this SDK refuses.
      const suffix = `${withoutTrailingSlashes(issuer)}/.well-known/openid-configuration`;
      const openid = await get(ctx, suffix);
      if (openid.status === 200 && openid.json !== undefined) {
        issuerMeta = openid;
        issuerMetaUrl = suffix;
        atOpenIdOnly = true;
      }
    }
    const servedIssuerMeta = add(
      ctx,
      "issuer.metadata",
      "MUST",
      "3.2",
      !atOpenIdOnly && issuerMeta.status === 200 && issuerMeta.json !== undefined,
      atOpenIdOnly
        ? `found at ${issuerMetaUrl} instead of ${String(specPath)} — agents fetch only the RFC 8414 URL`
        : outcome(specPath, issuerMeta),
    );

    if (issuerMeta.json !== undefined && (servedIssuerMeta || atOpenIdOnly)) {
      // The contents still get checked even when the path was wrong, so the report doesn't stop
      // at the path problem and hide whatever else is wrong inside the document.
      add(
        ctx,
        "issuer.identifier",
        "MUST",
        "3.2",
        issuerMeta.json["issuer"] === issuer,
        `issuer: ${String(issuerMeta.json["issuer"])} (expected ${issuer})`,
      );
      // The issuer confirms the link from its own side. Without it, a domain could name an
      // issuer that has never heard of it and agents would have no way to tell. RFC 9728 §3.3
      // compares the host case-insensitively and allows no path, which is what `listsDomain` does.
      const protectedResources = strings(issuerMeta.json["protected_resources"]);
      const namesDomain = protectedResources.some((entry) => {
        const match = /^https:\/\/([^/?#:@]+)$/i.exec(entry);
        return match?.[1]?.toLowerCase() === final.host.toLowerCase();
      });
      add(
        ctx,
        "issuer.protected-resources",
        "MUST",
        "3.2",
        namesDomain,
        protectedResources.length > 0
          ? `protected_resources: ${protectedResources.join(", ")} (expected ${resourceOrigin})`
          : "protected_resources absent",
      );
      const grants = strings(issuerMeta.json["grant_types_supported"]);
      add(
        ctx,
        "issuer.refresh-token",
        "MUST",
        "4.4",
        grants.includes("refresh_token"),
        `grant_types_supported: ${grants.join(", ") || "(absent)"}`,
      );
      // `fetchOAuthServer` requires each of these and throws without them, so a site missing one
      // is unusable however complete the rest of the chain looks.
      // `fetchOAuthServer` runs `httpsUrl` when an endpoint is required OR present, so an
      // optional endpoint spelled `http://` throws just as a missing required one does.
      const endpoint = (key: string, id: string, why: string, required: boolean): void => {
        const value = issuerMeta.json?.[key];
        if (!required && value === undefined) return;
        const url = typeof value === "string" ? httpsOrUndefined(value) : undefined;
        add(
          ctx,
          id,
          "MUST",
          "3.2",
          url !== undefined,
          url !== undefined
            ? `${key}: ${url.href}`
            : `${key} ${
                value === undefined ? `absent — ${why}` : `is not an https URL: ${String(value)}`
              }`,
        );
      };
      endpoint("token_endpoint", "issuer.token-endpoint", "no token can be issued", true);
      endpoint(
        "revocation_endpoint",
        "issuer.revocation-endpoint",
        "sign-out has nowhere to revoke",
        true,
      );
      endpoint(
        "authorization_endpoint",
        "issuer.authorization-endpoint",
        "authorization_code is listed as a grant",
        grants.includes("authorization_code"),
      );
      endpoint(
        "device_authorization_endpoint",
        "issuer.device-endpoint",
        "the device code grant is listed",
        grants.includes(DEVICE_CODE_GRANT),
      );
    }
  }

  // A Session an agent cannot spend anywhere.
  //
  // `discovery.surface` above is satisfied by a bare `web: {}`, and that is correct for a
  // Company offering only its website — the kit says such a Company publishes `protocol_version`,
  // `organization` and `web`, with NO `auth` and no issuer (3.1, 3.2). Having an issuer is the
  // claim that signing in buys the agent something, and that is what the domain's PRM settles,
  // not which keys `auth` happens to carry. Without `apis`, `agent` or a
  // `browser_session_endpoint` there is nowhere to spend the Session: the spec's own note on
  // `web` says that without that endpoint "Personal Agents browse the site as ordinary
  // signed-out visitors" (3.1).
  //
  // Real agents act on this. A Personal Agent weighing whether to use Poppy at all reasons that
  // a sign-in it cannot carry into the task is worth less than signing the User in through the
  // browser, and takes the browser instead — so the document is not merely thin, it loses to the
  // alternative. This is the difference between a document that passes and one that gets used.
  //
  // Each surface counts only when `parseDocument` would actually yield it: an `apis` list of
  // types this version doesn't read leaves `Company.apis` empty, an `agent` without a `poppy`
  // protocol yields no conversation endpoint, and a join URL that isn't https rejects the
  // document outright.
  //
  // The set is the one the reference validator's `website-only` message names — agent, apis,
  // tasks, web.browser_session_endpoint or an extension. The last two matter here: 0.4 moved
  // excluded tasks, the skill index and feedback to `tasks.endpoint`, which agents read once per
  // Session (9), and some extensions use Sessions. Nothing here can tell which do, so any
  // extension counts: for a SHOULD, a warning missed costs less than one raised against a
  // Company that is doing nothing wrong.
  const web = isObject(doc["web"]) ? doc["web"] : undefined;
  const agent = isObject(doc["agent"]) ? doc["agent"] : undefined;
  const spends: string[] = [];
  if (
    Array.isArray(doc["apis"]) &&
    doc["apis"].some(
      (entry) => isObject(entry) && (entry["type"] === "mcp" || entry["type"] === "openapi"),
    )
  )
    spends.push("apis");
  if (
    Array.isArray(agent?.["protocols"]) &&
    agent["protocols"].some((protocol) => isObject(protocol) && protocol["type"] === "poppy")
  )
    spends.push("agent");
  // `parseDiscovery` reads `tasks.endpoint` through `optionalUrl`, and only off 0.3.
  const tasks = isObject(doc["tasks"]) ? doc["tasks"] : undefined;
  const tasksEndpoint = tasks?.["endpoint"];
  if (
    version !== "0.3" &&
    typeof tasksEndpoint === "string" &&
    httpsOrUndefined(tasksEndpoint) !== undefined
  )
    spends.push("tasks.endpoint");
  const join = web?.["browser_session_endpoint"];
  if (typeof join === "string" && httpsOrUndefined(join) !== undefined)
    spends.push("web.browser_session_endpoint");
  // In the shape this version's `parseExtensions` reads: a list off 0.3, a single object on it.
  if (
    Object.values(isObject(doc["extensions"]) ? doc["extensions"] : {}).some((entry) =>
      version === "0.3" ? isObject(entry) : Array.isArray(entry) && entry.length > 0,
    )
  )
    spends.push("extensions");
  add(
    ctx,
    "surface.session-usable",
    "SHOULD",
    "3.1",
    issuer === "" || signInDisabled || spends.length > 0,
    issuer === ""
      ? "no issuer, so no Session is promised"
      : signInDisabled
        ? "auth.disabled — the Company offers no sign-in, so no Session is promised"
        : spends.length > 0
          ? `a Session reaches: ${spends.join(", ")}`
          : "the domain names an issuer with no apis, agent, tasks.endpoint, " +
            "browser_session_endpoint or extension — an agent that signs the User in has " +
            "nowhere to use the Session, so it signs them in through the browser instead " +
            "and ignores this document",
  );

  // ---- every API the document advertises -----------------------------------------------------
  const apis = Array.isArray(doc["apis"])
    ? doc["apis"].filter((entry): entry is Record<string, unknown> => isObject(entry))
    : [];
  // No `apis.advertised` check: `surface.session-usable` above asks the question that one was
  // reaching for, and asks it correctly. "No apis" said "agents can browse but not transact",
  // which is false for a Company whose agents transact through a joined browser session, and it
  // stayed quiet about the case that actually costs a Company its agents — auth advertised with
  // nowhere to spend the Session.

  for (const api of apis) {
    const declared = typeof api["url"] === "string" ? api["url"] : "";
    if (declared === "") continue;
    const type = api["type"];
    // `parseApis` returns early for any other type, before it looks at the URL, so a Company can
    // advertise a future API type without agents on this version caring (spec 7).
    if (type !== "mcp" && type !== "openapi") continue;
    // `parseApis` puts every URL through `httpsUrl`, which has no base to resolve against, so a
    // relative URL is not an API an agent can reach — it is a document `discover()` throws on.
    const declaredUrl = httpsOrUndefined(declared);
    if (declaredUrl === undefined) {
      add(
        ctx,
        `api.url:${declared}`,
        "MUST",
        "3.1",
        false,
        `${declared} is not an absolute https URL — agents refuse the whole document`,
      );
      continue;
    }

    // The resource an agent looks metadata up for. For MCP it is the API URL spelled exactly as
    // published, trailing slash included, because `#lookup` compares it verbatim. For OpenAPI the
    // URL is the description document, and the service is its first `servers` entry.
    let service = declaredUrl.href;
    if (type === "openapi") {
      const description = await get(ctx, declaredUrl);
      const served = add(
        ctx,
        `api.description:${declared}`,
        "MUST",
        "7",
        description.status === 200 && (description.text ?? "") !== "",
        outcome(declaredUrl, description),
      );
      if (!served) continue;
      // `new URL(server, descriptionUrl)` sits outside `openApiServer`'s own try/catch, and
      // `#loadOpenApiServers` catches the throw and drops the service rather than failing.
      try {
        service = openApiServer(description.text ?? "", declaredUrl.href);
      } catch {
        add(
          ctx,
          `api.servers:${declared}`,
          "MUST",
          "7",
          false,
          "the first servers entry is not a URL — agents drop this API",
        );
        continue;
      }
    }

    // A `servers` URL such as `data:text/plain,x` parses but has no origin, so the well-known
    // segment has nowhere to go and `resourceMetadataUrl` throws — outside the catch above.
    let expected: string;
    try {
      expected = String(resourceMetadataUrl(service));
    } catch {
      add(
        ctx,
        `api.servers:${declared}`,
        "MUST",
        "7",
        false,
        `${service} has no origin for the well-known segment — agents drop this API`,
      );
      continue;
    }
    const atSpecPath = await get(ctx, expected);
    let metadata = atSpecPath.status === 200 ? atSpecPath.json : undefined;
    if (metadata === undefined && type === "openapi" && atSpecPath.status === 404) {
      // An OpenAPI service without its own metadata is not broken: `#lookup` passes
      // `allowNotFound` and falls back to the Company's default token (spec 4.5). Only on a 404
      // though — it throws on a 500, a transport failure, or a body that isn't JSON.
      add(
        ctx,
        `api.prm:${declared}`,
        "SHOULD",
        "RFC 9728 §3.1",
        true,
        `${outcome(expected, atSpecPath)} — agents use the Company's default token for ${service}`,
      );
      continue;
    }
    add(
      ctx,
      `api.prm:${declared}`,
      "MUST",
      "RFC 9728 §3.1",
      metadata !== undefined,
      outcome(expected, atSpecPath),
    );

    if (metadata === undefined) {
      // Appending the well-known segment to the path is what many MCP servers do, so a 404 at
      // the spec path usually means the document is one URL over rather than missing. That is a
      // path failure, and its CONTENTS still have to be checked — otherwise the report stops at
      // the path problem and hides whatever else is wrong inside the document.
      const suffix = `${withoutTrailingSlashes(service)}${PRM}`;
      const atSuffix = await get(ctx, suffix);
      if (atSuffix.status === 200 && atSuffix.json !== undefined) {
        metadata = atSuffix.json;
        add(
          ctx,
          `api.prm-path:${declared}`,
          "MUST",
          "RFC 9728 §3.1",
          false,
          `found at ${suffix} instead — the well-known segment goes between origin and path`,
        );
      }
    }

    if (metadata === undefined) continue;

    // MCP compares verbatim; from 0.4 everything else compares ignoring trailing slashes, and a
    // service naming the Company's own origin means "use the default token" rather than a
    // mismatch (spec 4.5).
    const named = String(metadata["resource"]);
    const matches =
      type === "mcp"
        ? metadata["resource"] === service
        : withoutTrailingSlashes(named) === withoutTrailingSlashes(service) ||
          named === resourceOrigin;
    // MCP always throws on a mismatch, and so does 0.3 in effect: `#lookup` only reads a
    // mismatching resource as absent from 0.4 on, so a 0.3 agent asks for a token for the named
    // resource and sends it here. From 0.4 the fallback makes it a finding, not a break.
    const fatal = type === "mcp" || version === "0.3";
    add(
      ctx,
      `api.prm-resource:${declared}`,
      fatal ? "MUST" : "SHOULD",
      "RFC 9728 §3.3",
      matches,
      matches
        ? `resource: ${named}`
        : `resource: ${named} (expected ${service})${
            fatal ? "" : " — agents ignore it and use the Company's default token"
          }`,
    );

    if (type === "mcp") {
      // One Company, one identity namespace: an MCP server pointing somewhere else means a user
      // who signs in through the site is a different subject from the one the API sees.
      const servers = strings(metadata["authorization_servers"]);
      add(
        ctx,
        `api.mcp-issuer:${declared}`,
        "MUST",
        "7",
        issuer !== "" && servers.includes(issuer),
        `authorization_servers: ${servers.join(", ") || "(absent)"} — must include the Company issuer ${
          issuer || "(none found)"
        }`,
      );
    }
  }

  return ctx.results;
}

/** A report for a person to read: failures first, since that is what the reader came for. */
export function formatSiteReport(subject: string, results: readonly SiteResult[]): string {
  const failed = results.filter((result) => !result.ok);
  const must = failed.filter((result) => result.level === "MUST");
  const lines = [
    `${subject} — ${results.length} checks, ${failed.length} failing (${must.length} MUST)`,
    "",
  ];
  for (const result of failed) {
    lines.push(`  ✗ ${result.level.padEnd(6)} ${result.id}  [${result.cite}]`);
    lines.push(`      ${result.detail}`);
  }
  if (failed.length > 0) lines.push("");
  for (const result of results) {
    if (result.ok) lines.push(`  ✓ ${result.id}`);
  }
  return lines.join("\n");
}
