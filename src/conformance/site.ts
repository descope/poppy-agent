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

import { authorizationServerMetadataUrl, originOf, resourceMetadataUrl } from "../http.ts";
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
  finalUrl: string;
  error?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

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
    return { status: response.status, json, finalUrl: response.url || target };
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
  const origin = /^https?:\/\//.test(input)
    ? new URL(input).origin
    : originOf(new URL(`https://${input}`).host);

  // ---- the discovery document ---------------------------------------------------------------
  const discovery = await get(ctx, `${origin}${WELL_KNOWN}`);
  const servedDocument = add(
    ctx,
    "discovery.document",
    "MUST",
    "3.1",
    discovery.status === 200 && discovery.json !== undefined,
    discovery.error
      ? `fetch failed: ${discovery.error}`
      : `${origin}${WELL_KNOWN} → ${discovery.status}${discovery.json ? "" : " (not a JSON object)"}`,
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
  // Before 1.0 a version needs an exact major.minor match, so a stale one is not a soft failure:
  // an agent speaking 0.4 declines a 0.3 document outright rather than reading what it can.
  add(
    ctx,
    "discovery.version-current",
    "SHOULD",
    "3.4",
    version === "0.4",
    version === "0.4"
      ? "current"
      : `${version || "(none)"} — agents on 0.4 will decline this document`,
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
  const scopes = isObject(auth["scopes"]) ? auth["scopes"] : undefined;
  add(
    ctx,
    "discovery.scopes-described",
    "SHOULD",
    "4.7",
    scopes !== undefined && Object.keys(scopes).length > 0,
    scopes !== undefined && Object.keys(scopes).length > 0
      ? `${Object.keys(scopes).length} described`
      : "auth.scopes absent — the user reads these when approving",
  );

  // Plain names are reserved for the protocol; anyone else prefixes with a domain they own, and
  // each entry is a list with one object per major version of the extension.
  const extensions = isObject(doc["extensions"]) ? doc["extensions"] : {};
  for (const [extension, entry] of Object.entries(extensions)) {
    add(
      ctx,
      `extensions.name:${extension}`,
      "MUST",
      "3.3",
      extension.includes("/"),
      extension.includes("/")
        ? `${extension} is domain-prefixed`
        : `${extension} has no domain prefix — plain names are reserved for the protocol`,
    );
    add(
      ctx,
      `extensions.entries:${extension}`,
      "MUST",
      "3.3",
      Array.isArray(entry),
      Array.isArray(entry)
        ? `${entry.length} version ${entry.length === 1 ? "entry" : "entries"}`
        : "not a list of per-version entries",
    );
  }

  // ---- the domain's own protected resource metadata ------------------------------------------
  const declaredIssuer = typeof auth["issuer"] === "string" ? auth["issuer"] : "";
  const domainPrm = await get(ctx, `${origin}${PRM}`);
  const servedDomainPrm = add(
    ctx,
    "prm.domain",
    "MUST",
    "3.2",
    domainPrm.status === 200 && domainPrm.json !== undefined,
    `${origin}${PRM} → ${domainPrm.status}${
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
      domainPrm.json["resource"] === origin,
      `resource: ${String(domainPrm.json["resource"])} (expected ${origin})`,
    );
    authorizationServers = strings(domainPrm.json["authorization_servers"]);
    add(
      ctx,
      "prm.domain-names-issuer",
      "MUST",
      "3.1",
      declaredIssuer === "" || authorizationServers.includes(declaredIssuer),
      declaredIssuer === ""
        ? "auth.issuer absent, which is allowed when the metadata names one server"
        : `authorization_servers ${
            authorizationServers.includes(declaredIssuer) ? "includes" : "does NOT include"
          } ${declaredIssuer}`,
    );
  }

  // ---- the issuer's side of the same link ----------------------------------------------------
  const issuer = declaredIssuer || authorizationServers[0] || "";
  if (issuer !== "") {
    // RFC 8414 puts the well-known segment between origin and path, which matters because most
    // hosted issuers live under one. OpenID Connect Discovery's suffix form is also standard and
    // widely served, so a site answering only there is interoperable, not broken.
    let issuerMeta = await get(ctx, authorizationServerMetadataUrl(issuer));
    let issuerMetaUrl = String(authorizationServerMetadataUrl(issuer));
    if (issuerMeta.status !== 200 || issuerMeta.json === undefined) {
      const suffix = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
      const openid = await get(ctx, suffix);
      if (openid.status === 200 && openid.json !== undefined) {
        issuerMeta = openid;
        issuerMetaUrl = suffix;
      }
    }
    const servedIssuerMeta = add(
      ctx,
      "issuer.metadata",
      "MUST",
      "3.2",
      issuerMeta.status === 200 && issuerMeta.json !== undefined,
      `${issuerMetaUrl} → ${issuerMeta.status}`,
    );

    if (servedIssuerMeta && issuerMeta.json !== undefined) {
      add(
        ctx,
        "issuer.identifier",
        "MUST",
        "3.2",
        issuerMeta.json["issuer"] === issuer,
        `issuer: ${String(issuerMeta.json["issuer"])} (expected ${issuer})`,
      );
      // The issuer confirms the link from its own side. Without it, a domain could name an
      // issuer that has never heard of it and agents would have no way to tell.
      const protectedResources = strings(issuerMeta.json["protected_resources"]);
      add(
        ctx,
        "issuer.protected-resources",
        "MUST",
        "3.2",
        protectedResources.includes(origin),
        protectedResources.length > 0
          ? `protected_resources: ${protectedResources.join(", ")}`
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
    }
  }

  // ---- every API the document advertises -----------------------------------------------------
  const apis = Array.isArray(doc["apis"])
    ? doc["apis"].filter((entry): entry is Record<string, unknown> => isObject(entry))
    : [];
  add(
    ctx,
    "apis.advertised",
    "SHOULD",
    "3.1",
    apis.length > 0,
    apis.length > 0 ? `${apis.length} advertised` : "no apis — agents can browse but not transact",
  );

  for (const api of apis) {
    const declared = typeof api["url"] === "string" ? api["url"] : "";
    if (declared === "") continue;
    // The resource identifier is the URL with no trailing slash: it is compared verbatim against
    // what the metadata returns and against a token's `aud`, so the two must be spelled alike.
    const resource = new URL(declared, origin).toString().replace(/\/+$/, "");
    const expected = String(resourceMetadataUrl(resource));

    const atSpecPath = await get(ctx, expected);
    let metadata = atSpecPath.status === 200 ? atSpecPath.json : undefined;
    add(
      ctx,
      `api.prm:${declared}`,
      "MUST",
      "RFC 9728 §3.1",
      metadata !== undefined,
      `${expected} → ${atSpecPath.status}`,
    );

    if (metadata === undefined) {
      // Appending the well-known segment to the path is what many MCP servers do, so a 404 at
      // the spec path usually means the document is one URL over rather than missing. That is a
      // path failure, and its CONTENTS still have to be checked — otherwise the report stops at
      // the path problem and hides whatever else is wrong inside the document.
      const suffix = `${resource}${PRM}`;
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

    add(
      ctx,
      `api.prm-resource:${declared}`,
      "MUST",
      "RFC 9728 §3.3",
      metadata["resource"] === resource,
      `resource: ${String(metadata["resource"])} (expected ${resource})`,
    );

    if (api["type"] === "mcp") {
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
