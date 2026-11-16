import { describe, expect, it } from "vitest";
import { checkSite, formatSiteReport, type SiteResult } from "../src/conformance/site.ts";

const ORIGIN = "https://shop.test";
const ISSUER = "https://auth.test/v1/apps/shop";
const MCP = "https://mcp.shop.test/mcp";

/** A site that satisfies every rule, as the starting point each case mutates. */
function conformingSite(): Record<string, unknown> {
  return {
    [`${ORIGIN}/.well-known/poppy.json`]: {
      protocol_version: "0.4",
      organization: { name: "Shop", domain: "shop.test" },
      auth: { issuer: ISSUER, scopes: { "orders:read": "See your orders" } },
      apis: [{ type: "mcp", url: MCP }],
      extensions: { "shop.test/loyalty": [{ version: "1" }] },
    },
    [`${ORIGIN}/.well-known/oauth-protected-resource`]: {
      resource: ORIGIN,
      authorization_servers: [ISSUER],
    },
    // RFC 8414: the well-known segment goes between origin and path, so an issuer under a path
    // publishes here and not at `${ISSUER}/.well-known/...`.
    "https://auth.test/.well-known/oauth-authorization-server/v1/apps/shop": {
      issuer: ISSUER,
      protected_resources: [ORIGIN],
      grant_types_supported: ["authorization_code", "refresh_token"],
    },
    "https://mcp.shop.test/.well-known/oauth-protected-resource/mcp": {
      resource: MCP,
      authorization_servers: [ISSUER],
    },
  };
}

/** Serves a fixture map; anything absent is a 404, as a real host would answer. */
function serve(documents: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = documents[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body instanceof Response) return body.clone();
    return Response.json(body, { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function check(documents: Record<string, unknown>): Promise<SiteResult[]> {
  return await checkSite("shop.test", { fetch: serve(documents) });
}

const byId = (results: SiteResult[], id: string): SiteResult | undefined =>
  results.find((result) => result.id === id);

const failures = (results: SiteResult[]): string[] =>
  results.filter((result) => !result.ok).map((result) => result.id);

describe("checkSite", () => {
  it("passes a site that satisfies every rule", async () => {
    const results = await check(conformingSite());
    expect(failures(results)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  });

  it("stops when there is no discovery document, rather than reporting the rest as failures", async () => {
    const results = await check({});
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("discovery.document");
    expect(results[0]?.ok).toBe(false);
  });

  it("reports a transport failure as a finding instead of throwing", async () => {
    const results = await checkSite("shop.test", {
      fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    expect(results[0]?.detail).toContain("ECONNREFUSED");
  });

  it("catches a stale protocol_version and a domain that isn't the serving host", async () => {
    const documents = conformingSite();
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...(documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>),
      protocol_version: "0.1",
      organization: { name: "Shop", domain: "elsewhere.test" },
    };
    const results = await check(documents);
    expect(byId(results, "discovery.version-current")?.ok).toBe(false);
    expect(byId(results, "discovery.domain")?.ok).toBe(false);
    expect(byId(results, "discovery.domain")?.detail).toContain("elsewhere.test");
  });

  it("catches auth.device, which was removed after 0.1", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      auth: { ...(doc["auth"] as Record<string, unknown>), device: { enabled: true } },
    };
    expect(byId(await check(documents), "discovery.no-auth-device")?.ok).toBe(false);
  });

  it("requires extensions to be domain-prefixed with a list of per-version entries", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      extensions: { loyalty: { version: "1" } },
    };
    const results = await check(documents);
    expect(byId(results, "extensions.name:loyalty")?.ok).toBe(false);
    expect(byId(results, "extensions.entries:loyalty")?.ok).toBe(false);
  });

  it("reads a missing domain PRM the way an agent does — as no issuer at all", async () => {
    const documents = conformingSite();
    delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
    const results = await check(documents);
    const result = byId(results, "prm.domain");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("no issuer");
  });

  it("catches a domain PRM whose resource carries a path", async () => {
    const documents = conformingSite();
    documents[`${ORIGIN}/.well-known/oauth-protected-resource`] = {
      resource: `${ORIGIN}/agent_resource`,
      authorization_servers: [ISSUER],
    };
    const result = byId(await check(documents), "prm.domain-resource");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("expected https://shop.test");
  });

  it("catches an issuer the domain names but whose metadata doesn't name the domain back", async () => {
    const documents = conformingSite();
    documents["https://auth.test/.well-known/oauth-authorization-server/v1/apps/shop"] = {
      issuer: ISSUER,
      protected_resources: ["https://other.test"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    };
    const result = byId(await check(documents), "issuer.protected-resources");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("other.test");
  });

  it("accepts an issuer that serves only the OpenID Connect discovery path", async () => {
    const documents = conformingSite();
    const metadata =
      documents["https://auth.test/.well-known/oauth-authorization-server/v1/apps/shop"];
    delete documents["https://auth.test/.well-known/oauth-authorization-server/v1/apps/shop"];
    documents[`${ISSUER}/.well-known/openid-configuration`] = metadata;
    const results = await check(documents);
    expect(byId(results, "issuer.metadata")?.ok).toBe(true);
    expect(failures(results)).toEqual([]);
  });

  it("flags a refresh_token grant the issuer doesn't support", async () => {
    const documents = conformingSite();
    documents["https://auth.test/.well-known/oauth-authorization-server/v1/apps/shop"] = {
      issuer: ISSUER,
      protected_resources: [ORIGIN],
      grant_types_supported: ["authorization_code"],
    };
    expect(byId(await check(documents), "issuer.refresh-token")?.ok).toBe(false);
  });

  it("notes a site with no apis, which agents can browse but not transact with", async () => {
    const documents = conformingSite();
    const doc = { ...(documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>) };
    delete doc["apis"];
    documents[`${ORIGIN}/.well-known/poppy.json`] = doc;
    const result = byId(await check(documents), "apis.advertised");
    expect(result?.ok).toBe(false);
    expect(result?.level).toBe("SHOULD");
  });

  describe("an API whose metadata is at the suffix path", () => {
    /** Where many MCP servers put it: the well-known segment appended to the path. */
    const SUFFIX = `${MCP}/.well-known/oauth-protected-resource`;

    function atSuffix(metadata: Record<string, unknown>): Record<string, unknown> {
      const documents = conformingSite();
      delete documents["https://mcp.shop.test/.well-known/oauth-protected-resource/mcp"];
      documents[SUFFIX] = metadata;
      return documents;
    }

    it("reports the path and says where the document actually is", async () => {
      const results = await check(atSuffix({ resource: MCP, authorization_servers: [ISSUER] }));
      expect(byId(results, `api.prm:${MCP}`)?.ok).toBe(false);
      const path = byId(results, `api.prm-path:${MCP}`);
      expect(path?.ok).toBe(false);
      expect(path?.detail).toContain(SUFFIX);
    });

    // The regression this suite exists for. An earlier version stopped once the document wasn't
    // at the spec path, so the issuer mismatch below never appeared and the report read as a
    // shorter list of problems than the site actually had.
    it("still checks its contents, so a second failure inside it is not hidden", async () => {
      const results = await check(
        atSuffix({ resource: MCP, authorization_servers: ["https://auth.test/v1/apps/other"] }),
      );
      const issuer = byId(results, `api.mcp-issuer:${MCP}`);
      expect(issuer?.ok).toBe(false);
      expect(issuer?.detail).toContain("apps/other");
      expect(issuer?.detail).toContain(ISSUER);
    });
  });

  it("catches an API PRM that names a different resource", async () => {
    const documents = conformingSite();
    documents["https://mcp.shop.test/.well-known/oauth-protected-resource/mcp"] = {
      resource: "https://mcp.shop.test/",
      authorization_servers: [ISSUER],
    };
    const result = byId(await check(documents), `api.prm-resource:${MCP}`);
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain(`expected ${MCP}`);
  });

  it("checks an API URL given relative to the site", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      apis: [{ type: "mcp", url: "/mcp" }],
    };
    documents[`${ORIGIN}/.well-known/oauth-protected-resource/mcp`] = {
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ISSUER],
    };
    expect(failures(await check(documents))).toEqual([]);
  });
});

describe("formatSiteReport", () => {
  it("puts failures first with their citation and detail", async () => {
    const documents = conformingSite();
    delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
    const report = formatSiteReport("shop.test", await check(documents));
    const lines = report.split("\n");
    expect(lines[0]).toContain("failing");
    expect(lines[0]).toContain("MUST");
    expect(report.indexOf("✗")).toBeLessThan(report.indexOf("✓"));
    expect(report).toContain("[3.2]");
  });

  it("says so plainly when nothing failed", async () => {
    const report = formatSiteReport("shop.test", await check(conformingSite()));
    expect(report).toContain("0 failing (0 MUST)");
    expect(report).not.toContain("✗");
  });
});
