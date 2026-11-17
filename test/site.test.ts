import { describe, expect, it } from "vitest";
import { compatible, SUPPORTED_PROTOCOL_VERSIONS } from "../src/discovery.ts";
import {
  checkSite,
  formatSiteReport,
  NEWEST_VERSION,
  type SiteResult,
} from "../src/conformance/site.ts";

const ORIGIN = "https://shop.test";
const ISSUER = "https://auth.test/v1/apps/shop";
const MCP = "https://mcp.shop.test/mcp";
/** Where RFC 8414 puts the metadata for an issuer that lives under a path. */
const AS_METADATA = "https://auth.test/.well-known/oauth-authorization-server/v1/apps/shop";

/**
 * The issuer metadata `fetchOAuthServer` accepts: it throws without a token or revocation
 * endpoint, and without an authorization endpoint when `authorization_code` is listed.
 */
function issuerMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    protected_resources: [ORIGIN],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint: "https://auth.test/oauth2/token",
    revocation_endpoint: "https://auth.test/oauth2/revoke",
    authorization_endpoint: "https://auth.test/oauth2/authorize",
    ...overrides,
  };
}

/** A site that satisfies every rule, as the starting point each case mutates. */
function conformingSite(): Record<string, unknown> {
  return {
    [`${ORIGIN}/.well-known/poppy.json`]: {
      // The version agents prefer, so `discovery.version-current` passes on a site that is current.
      // Taken from NEWEST_VERSION, not pinned: pinning a literal only moves this breakage to the
      // next version the SDK adds, which is how adding 1.0 broke every case here in the first place.
      protocol_version: NEWEST_VERSION,
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
    [AS_METADATA]: issuerMetadata(),
    "https://mcp.shop.test/.well-known/oauth-protected-resource/mcp": {
      resource: MCP,
      authorization_servers: [ISSUER],
    },
  };
}

/**
 * Serves a fixture map; anything absent is a 404, as a real host would answer. `redirects` moves a
 * URL somewhere else and reports the destination as `response.url`, the way `redirect: "follow"`
 * does — which is how the apex → www case gets exercised at all.
 */
function serve(
  documents: Record<string, unknown>,
  redirects: Record<string, string> = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const asked = String(input);
    const url = redirects[asked] ?? asked;
    const body = documents[url];
    const response =
      body === undefined
        ? new Response("not found", { status: 404 })
        : body instanceof Response
          ? body.clone()
          : Response.json(body, { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch;
}

async function check(
  documents: Record<string, unknown>,
  redirects: Record<string, string> = {},
): Promise<SiteResult[]> {
  return await checkSite("shop.test", { fetch: serve(documents, redirects) });
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

  // The fixture declares `auth.issuer`, so a 404 here is the case `findIssuer` throws on: the
  // document names an issuer the domain will not confirm. Without a declared issuer the same 404
  // is a Company that simply has none, which the website-only case below covers.
  it("fails a missing domain PRM when auth.issuer names one anyway", async () => {
    const documents = conformingSite();
    delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
    const result = byId(await check(documents), "prm.domain");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain(ISSUER);
  });

  // `auth.issuer: ""` is not "no issuer declared" — `parseDocument` puts any present value
  // through `string()`, so this is a document the SDK rejects, not a website-only Company.
  it("does not read an empty auth.issuer as no issuer at all", async () => {
    const documents = conformingSite();
    const poppy = { ...(documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>) };
    documents[`${ORIGIN}/.well-known/poppy.json`] = { ...poppy, auth: { issuer: "" } };
    delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
    expect(byId(await check(documents), "prm.domain")?.ok).toBe(false);
  });

  describe("a signed_in conversation", () => {
    function withConversation(access: string, keepPrm: boolean): Record<string, unknown> {
      const documents = conformingSite();
      const poppy = {
        ...(documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>),
      };
      delete poppy["auth"];
      // Agent-only: the fixture's MCP API names an issuer, and with none resolved it would fail
      // `api.mcp-issuer` — a real failure, but not the one these cases are about.
      delete poppy["apis"];
      documents[`${ORIGIN}/.well-known/poppy.json`] = {
        ...poppy,
        agent: { protocols: [{ type: "poppy", endpoint: `${ORIGIN}/poppy/agent`, access }] },
      };
      if (!keepPrm) delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
      return documents;
    }

    // The regression `prm.domain` used to hide: `discover()` throws on this document, so a report
    // with no MUST failure in it would be telling a Company that agents can reach a site they
    // refuse outright.
    it("fails without an issuer, and does not leave the report clean", async () => {
      const results = await check(withConversation("signed_in", false));
      const result = byId(results, "agent.signed-in-needs-issuer");
      expect(result?.ok).toBe(false);
      expect(result?.level).toBe("MUST");
      expect(results.filter((r) => !r.ok && r.level === "MUST").map((r) => r.id)).toContain(
        "agent.signed-in-needs-issuer",
      );
    });

    it("passes when the domain names an issuer", async () => {
      const result = byId(
        await check(withConversation("signed_in", true)),
        "agent.signed-in-needs-issuer",
      );
      expect(result?.ok).toBe(true);
    });

    // `session` access, the default, needs no issuer — the rule must not fire for it.
    it("is not checked for a session-access conversation", async () => {
      const results = await check(withConversation("session", false));
      expect(byId(results, "agent.signed-in-needs-issuer")).toBeUndefined();
      expect(results.filter((r) => !r.ok && r.level === "MUST")).toEqual([]);
    });
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
    documents[AS_METADATA] = issuerMetadata({ protected_resources: ["https://other.test"] });
    const result = byId(await check(documents), "issuer.protected-resources");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("other.test");
  });

  // `fetchOAuthServer` fetches only the RFC 8414 URL. Reporting this as a pass would hand a site
  // a green report for a chain every agent built on this SDK refuses.
  it("reports an issuer that serves only the OpenID Connect path, and still reads it", async () => {
    const documents = conformingSite();
    delete documents[AS_METADATA];
    documents[`${ISSUER}/.well-known/openid-configuration`] = issuerMetadata({
      protected_resources: ["https://other.test"],
    });
    const results = await check(documents);
    const metadata = byId(results, "issuer.metadata");
    expect(metadata?.ok).toBe(false);
    expect(metadata?.detail).toContain("openid-configuration");
    expect(metadata?.detail).toContain("RFC 8414");
    // Found anyway, so what is inside it is still checked.
    expect(byId(results, "issuer.protected-resources")?.ok).toBe(false);
    expect(byId(results, "issuer.refresh-token")?.ok).toBe(true);
  });

  it("flags a refresh_token grant the issuer doesn't support", async () => {
    const documents = conformingSite();
    documents[AS_METADATA] = issuerMetadata({ grant_types_supported: ["authorization_code"] });
    expect(byId(await check(documents), "issuer.refresh-token")?.ok).toBe(false);
  });

  describe("a Session with nowhere to go", () => {
    /** The document with `apis` dropped and whatever surface the case is about put back. */
    function surfaced(doc: Record<string, unknown>): Record<string, unknown> {
      const documents = conformingSite();
      const poppy = {
        ...(documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>),
      };
      delete poppy["apis"];
      // `extensions` goes too: an extension is itself a surface a Session reaches, so leaving
      // the fixture's one in place would make every case below pass for the wrong reason.
      delete poppy["extensions"];
      documents[`${ORIGIN}/.well-known/poppy.json`] = { ...poppy, ...doc };
      return documents;
    }

    // The shape real sites ship, and the one a Personal Agent declines: an issuer and scopes
    // promising a Session, and no apis, agent or browser join to spend it on.
    it("fails a document that advertises auth with no surface to use it on", async () => {
      const results = await check(surfaced({ web: {} }));
      const result = byId(results, "surface.session-usable");
      expect(result?.ok).toBe(false);
      expect(result?.level).toBe("SHOULD");
      expect(result?.detail).toContain("browser");
      // The MUST above is satisfied by `web` alone, which is why this check has to exist.
      expect(byId(results, "discovery.surface")?.ok).toBe(true);
    });

    // The kit's website-only Company: `protocol_version`, `organization` and `web`, no `auth`.
    // Nothing is promised, so nothing is unspendable.
    it("passes a website-only document, which has no issuer at all", async () => {
      const documents = conformingSite();
      const poppy = {
        ...(documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>),
      };
      delete poppy["apis"];
      delete poppy["auth"];
      documents[`${ORIGIN}/.well-known/poppy.json`] = { ...poppy, web: {} };
      // What makes it website-only is the absent issuer, not the absent `auth` key.
      delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
      const results = await check(documents);
      const result = byId(results, "surface.session-usable");
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain("no issuer");
      // Asserting the one rule hid that this very site was failing `prm.domain`, so the Company
      // the comment calls valid exited non-zero. The whole report has to be clean, not one line
      // of it: `discover()` accepts this Company, so nothing here may record a MUST against it.
      expect(results.filter((r) => !r.ok && r.level === "MUST").map((r) => r.id)).toEqual([]);
    });

    // `findIssuer` returns no issuer for an empty `authorization_servers`, so this Company is
    // signed-out only however much `auth` it publishes.
    it("passes a document with scopes but no authorization server", async () => {
      const documents = surfaced({ web: {} });
      documents[`${ORIGIN}/.well-known/oauth-protected-resource`] = {
        resource: ORIGIN,
        authorization_servers: [],
      };
      const poppy = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
      documents[`${ORIGIN}/.well-known/poppy.json`] = {
        ...poppy,
        auth: { scopes: { "orders:read": "See your orders" } },
      };
      expect(byId(await check(documents), "surface.session-usable")?.ok).toBe(true);
    });

    it("passes a site whose only surface is browser join", async () => {
      const results = await check(
        surfaced({ web: { browser_session_endpoint: `${ORIGIN}/poppy/browser-session` } }),
      );
      const result = byId(results, "surface.session-usable");
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain("browser_session_endpoint");
    });

    it("passes a site whose only surface is a Company Agent", async () => {
      const result = byId(
        await check(
          surfaced({
            agent: { protocols: [{ type: "poppy", endpoint: `${ORIGIN}/poppy/conversations` }] },
          }),
        ),
        "surface.session-usable",
      );
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain("agent");
    });

    // `parseProtocols` throws without a `protocols` list and drops protocols of other types, so
    // neither shape leaves the agent anywhere to talk.
    it("does not count an agent the SDK would yield nothing from", async () => {
      const bare = byId(
        await check(surfaced({ agent: { url: `${ORIGIN}/poppy/agent` } })),
        "surface.session-usable",
      );
      expect(bare?.ok).toBe(false);
      const other = byId(
        await check(surfaced({ agent: { protocols: [{ type: "a2a", endpoint: ORIGIN }] } })),
        "surface.session-usable",
      );
      expect(other?.ok).toBe(false);
    });

    it("does not count an apis list the SDK reads nothing from", async () => {
      const result = byId(
        await check(surfaced({ apis: [{ type: "graphql", url: `${ORIGIN}/graphql` }] })),
        "surface.session-usable",
      );
      expect(result?.ok).toBe(false);
    });

    // `optionalUrl` puts the join URL through `httpsUrl`, so this rejects the whole document.
    it("does not count a browser join endpoint that isn't https", async () => {
      const result = byId(
        await check(surfaced({ web: { browser_session_endpoint: "/poppy/browser-session" } })),
        "surface.session-usable",
      );
      expect(result?.ok).toBe(false);
    });

    it("names apis when that is where the Session goes", async () => {
      const result = byId(await check(conformingSite()), "surface.session-usable");
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain("apis");
    });

    // GoFundMe's shape: the domain names an issuer, and `auth.disabled` says agents get no
    // sign-in from it (3.2). Nothing is promised, so a bare `web: {}` strands nothing, and
    // `PoppyUser` refuses to start sign-in here — warning would be noise.
    it("passes a document whose auth is disabled, however bare the rest is", async () => {
      const results = await check(surfaced({ auth: { issuer: ISSUER, disabled: true }, web: {} }));
      const usable = byId(results, "surface.session-usable");
      expect(usable?.ok).toBe(true);
      expect(usable?.detail).toContain("auth.disabled");
      // The same gate spares the scope check, for the same reason.
      const described = byId(results, "discovery.scopes-described");
      expect(described?.ok).toBe(true);
      expect(described?.detail).toContain("auth.disabled");
    });

    // 0.4 moved excluded tasks, the skill index and feedback here, and agents read it once per
    // Session (9), so an endpoint is somewhere a Session goes.
    it("passes a site whose only surface is a tasks endpoint", async () => {
      const result = byId(
        await check(surfaced({ tasks: { endpoint: `${ORIGIN}/poppy/tasks` }, web: {} })),
        "surface.session-usable",
      );
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain("tasks.endpoint");
    });

    // `parseDiscovery` reads `tasks.endpoint` through `optionalUrl`, and only off 0.3.
    it("does not count a tasks endpoint the SDK would yield nothing from", async () => {
      const notHttps = await check(
        surfaced({ tasks: { endpoint: "http://shop.test/t" }, web: {} }),
      );
      expect(byId(notHttps, "surface.session-usable")?.ok).toBe(false);
    });

    // The reference validator counts any extension, and so does this: a few use Sessions, and
    // nothing here can tell which, so it declines to warn rather than warn wrongly.
    it("counts an extension as somewhere a Session goes", async () => {
      const result = byId(
        await check(surfaced({ extensions: { "shop.test/loyalty": [{ version: "1" }] }, web: {} })),
        "surface.session-usable",
      );
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain("extensions");
    });

    // Off 0.3 `parseExtensions` wants a list, so a bare object yields no extension at all.
    it("does not count an extension in a shape this version does not read", async () => {
      const result = byId(
        await check(surfaced({ extensions: { "shop.test/loyalty": { version: "1" } }, web: {} })),
        "surface.session-usable",
      );
      expect(result?.ok).toBe(false);
    });

    // An empty list is not a surface, however much it looks like one in the document.
    it("does not count an empty apis list as somewhere to go", async () => {
      expect(byId(await check(surfaced({ apis: [], web: {} })), "surface.session-usable")?.ok).toBe(
        false,
      );
    });
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

  // `parseApis` runs each URL through `httpsUrl`, which has no base: a relative one throws.
  it("rejects an API URL given relative to the site", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      apis: [{ type: "mcp", url: "/mcp" }],
    };
    const result = byId(await check(documents), "api.url:/mcp");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("absolute https URL");
  });

  // Every check below this line pins a rule against what `discover()` actually does, because a
  // green report for a site the SDK rejects is worse than no report at all.

  it("reads the PRM and the issuer link against the host that served the document", async () => {
    const WWW = "https://www.shop.test";
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${WWW}/.well-known/poppy.json`] = {
      ...doc,
      organization: { name: "Shop", domain: "www.shop.test" },
    };
    delete documents[`${ORIGIN}/.well-known/poppy.json`];
    delete documents[`${ORIGIN}/.well-known/oauth-protected-resource`];
    documents[`${WWW}/.well-known/oauth-protected-resource`] = {
      resource: WWW,
      authorization_servers: [ISSUER],
    };
    documents[AS_METADATA] = issuerMetadata({ protected_resources: [WWW] });
    const results = await check(documents, {
      [`${ORIGIN}/.well-known/poppy.json`]: `${WWW}/.well-known/poppy.json`,
    });
    expect(failures(results)).toEqual([]);
  });

  it("requires auth.issuer when the domain lists more than one server", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      auth: { scopes: { "orders:read": "See your orders" } },
    };
    documents[`${ORIGIN}/.well-known/oauth-protected-resource`] = {
      resource: ORIGIN,
      authorization_servers: [ISSUER, "https://auth.test/v1/apps/other"],
    };
    const result = byId(await check(documents), "prm.domain-names-issuer");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("auth.issuer is required");
  });

  it("accepts a single listed server with no auth.issuer, the way findIssuer does", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      auth: { scopes: { "orders:read": "See your orders" } },
    };
    expect(byId(await check(documents), "prm.domain-names-issuer")?.ok).toBe(true);
  });

  it("catches an issuer with no token endpoint, which the SDK throws on", async () => {
    const documents = conformingSite();
    const metadata = issuerMetadata();
    delete metadata["token_endpoint"];
    documents[AS_METADATA] = metadata;
    const result = byId(await check(documents), "issuer.token-endpoint");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("absent");
  });

  it("requires the device endpoint only when the device grant is listed", async () => {
    const documents = conformingSite();
    documents[AS_METADATA] = issuerMetadata({
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
    });
    expect(byId(await check(documents), "issuer.device-endpoint")?.ok).toBe(false);
    // Without the grant the endpoint is not required, so the rule isn't reported at all.
    expect(byId(await check(conformingSite()), "issuer.device-endpoint")).toBeUndefined();
  });

  it("reports a malformed auth.issuer instead of throwing the report away", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      auth: { issuer: "auth.example.com" },
    };
    const results = await check(documents);
    const result = byId(results, "issuer.url");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("auth.example.com");
    // The point of the rule: the checks gathered before it survive.
    expect(byId(results, "discovery.document")?.ok).toBe(true);
  });

  it("allows the plain extension names the protocol defines", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      extensions: { operations: [{ version: "2" }] },
    };
    const results = await check(documents);
    expect(byId(results, "extensions.name:operations")?.ok).toBe(true);
    expect(byId(results, "extensions.entries:operations")?.ok).toBe(true);
  });

  it("reads a 0.3 extension entry as the single object 0.3 spells it", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      protocol_version: "0.3",
      extensions: { "shop.test/loyalty": { version: "1" } },
    };
    const results = await check(documents);
    expect(byId(results, "extensions.entries:shop.test/loyalty")?.ok).toBe(true);
    // 0.3 is still a version an agent speaks, so only the SHOULD about being current fails.
    expect(byId(results, "discovery.version-supported")?.ok).toBe(true);
    expect(byId(results, "discovery.version-current")?.ok).toBe(false);
  });

  it("fails a version no agent can speak, and accepts one reached through a link", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = { ...doc, protocol_version: "9.9" };
    expect(byId(await check(documents), "discovery.version-supported")?.ok).toBe(false);

    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      protocol_version: "9.9",
      supported_versions: { [NEWEST_VERSION]: `${ORIGIN}/poppy-linked.json` },
    };
    // `discover()` fetches the linked document, so a link to nothing is not a version on offer.
    expect(byId(await check(documents), "discovery.version-supported")?.ok).toBe(false);

    documents[`${ORIGIN}/poppy-linked.json`] = { ...doc, protocol_version: NEWEST_VERSION };
    const linked = await check(documents);
    expect(byId(linked, "discovery.version-supported")?.ok).toBe(true);
    expect(byId(linked, "discovery.version-current")?.ok).toBe(true);
  });

  // `fetchLinkedDocument` passes `followRedirects: false` and throws on any 3xx.
  it("drops a linked document that is only reachable through a redirect", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      protocol_version: "9.9",
      supported_versions: { [NEWEST_VERSION]: `${ORIGIN}/poppy-linked.json` },
    };
    documents[`${ORIGIN}/elsewhere.json`] = { ...doc, protocol_version: NEWEST_VERSION };
    const results = await check(documents, {
      [`${ORIGIN}/poppy-linked.json`]: `${ORIGIN}/elsewhere.json`,
    });
    expect(byId(results, "discovery.version-supported")?.ok).toBe(false);
  });

  it("drops a linked document that disagrees about its own version", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      protocol_version: "9.9",
      supported_versions: { "0.4": `${ORIGIN}/poppy-0.4.json` },
    };
    documents[`${ORIGIN}/poppy-0.4.json`] = { ...doc, protocol_version: "0.3" };
    expect(byId(await check(documents), "discovery.version-supported")?.ok).toBe(false);
  });

  it("checks an optional endpoint that is present, the way fetchOAuthServer does", async () => {
    const documents = conformingSite();
    documents[AS_METADATA] = issuerMetadata({
      grant_types_supported: ["refresh_token"],
      authorization_endpoint: "http://auth.test/oauth2/authorize",
    });
    const result = byId(await check(documents), "issuer.authorization-endpoint");
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("not an https URL");
  });

  it("skips an API type the SDK ignores rather than failing the document", async () => {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      apis: [
        { type: "graphql", url: "/graphql" },
        { type: "mcp", url: MCP },
      ],
    };
    const results = await check(documents);
    expect(results.filter((result) => result.id.endsWith(":/graphql"))).toEqual([]);
    expect(failures(results)).toEqual([]);
  });

  it("keeps an MCP URL's trailing slash, which its metadata is compared against verbatim", async () => {
    const WITH_SLASH = `${MCP}/`;
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      apis: [{ type: "mcp", url: WITH_SLASH }],
    };
    documents["https://mcp.shop.test/.well-known/oauth-protected-resource/mcp"] = {
      resource: WITH_SLASH,
      authorization_servers: [ISSUER],
    };
    expect(failures(await check(documents))).toEqual([]);
  });

  describe("an OpenAPI API", () => {
    const DESCRIPTION = "https://api.shop.test/openapi.json";
    const SERVER = "https://api.shop.test/v1";

    function withOpenApi(): Record<string, unknown> {
      const documents = conformingSite();
      const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
      documents[`${ORIGIN}/.well-known/poppy.json`] = {
        ...doc,
        apis: [{ type: "openapi", url: DESCRIPTION }],
      };
      documents[DESCRIPTION] = { servers: [{ url: SERVER }] };
      return documents;
    }

    // `#lookup` falls back to the Company's default token on a 404 here, so a MUST failure would
    // make every working OpenAPI Company exit non-zero.
    it("treats missing metadata as the default token rather than a failure", async () => {
      const results = await check(withOpenApi());
      const prm = byId(results, `api.prm:${DESCRIPTION}`);
      expect(prm?.ok).toBe(true);
      expect(prm?.detail).toContain("default token");
      expect(failures(results)).toEqual([]);
    });

    it("looks for the metadata at the servers URL, not at the description", async () => {
      const documents = withOpenApi();
      documents["https://api.shop.test/.well-known/oauth-protected-resource/v1"] = {
        resource: SERVER,
        authorization_servers: [ISSUER],
      };
      const results = await check(documents);
      expect(byId(results, `api.prm:${DESCRIPTION}`)?.ok).toBe(true);
      expect(byId(results, `api.prm-resource:${DESCRIPTION}`)?.ok).toBe(true);
      expect(failures(results)).toEqual([]);
    });

    it("reports a servers URL that isn't one, instead of throwing", async () => {
      const documents = withOpenApi();
      documents[DESCRIPTION] = { servers: [{ url: "http://[" }] };
      const results = await check(documents);
      const result = byId(results, `api.servers:${DESCRIPTION}`);
      expect(result?.ok).toBe(false);
      // The findings gathered before it survive, which is the whole point.
      expect(byId(results, "discovery.document")?.ok).toBe(true);
    });

    // `#lookup` passes `allowNotFound`, so only a 404 falls back to the default token.
    it("does not read a 500 as the default-token fallback", async () => {
      const documents = withOpenApi();
      documents["https://api.shop.test/.well-known/oauth-protected-resource/v1"] = new Response(
        "boom",
        { status: 500 },
      );
      const result = byId(await check(documents), `api.prm:${DESCRIPTION}`);
      expect(result?.ok).toBe(false);
      expect(result?.level).toBe("MUST");
    });

    it("reports a resource mismatch at SHOULD, since agents fall back rather than fail", async () => {
      const documents = withOpenApi();
      documents["https://api.shop.test/.well-known/oauth-protected-resource/v1"] = {
        resource: "https://api.shop.test/v2",
        authorization_servers: [ISSUER],
      };
      const result = byId(await check(documents), `api.prm-resource:${DESCRIPTION}`);
      expect(result?.ok).toBe(false);
      expect(result?.level).toBe("SHOULD");
      expect(result?.detail).toContain("default token");
    });

    // `resourceMetadataUrl` throws on a URL with no origin, outside the openApiServer catch.
    it("reports a servers URL with no origin, instead of throwing", async () => {
      const documents = withOpenApi();
      documents[DESCRIPTION] = { servers: [{ url: "data:text/plain,x" }] };
      const results = await check(documents);
      expect(byId(results, `api.servers:${DESCRIPTION}`)?.ok).toBe(false);
      expect(byId(results, "discovery.document")?.ok).toBe(true);
    });

    // `#lookup` only reads a mismatching resource as absent from 0.4 on. A 0.3 agent asks for a
    // token for the resource the metadata names and sends it here, so this one really breaks.
    it("keeps a resource mismatch at MUST on 0.3", async () => {
      const documents = withOpenApi();
      const poppy = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
      documents[`${ORIGIN}/.well-known/poppy.json`] = { ...poppy, protocol_version: "0.3" };
      documents["https://api.shop.test/.well-known/oauth-protected-resource/v1"] = {
        resource: "https://api.shop.test/v2",
        authorization_servers: [ISSUER],
      };
      const result = byId(await check(documents), `api.prm-resource:${DESCRIPTION}`);
      expect(result?.ok).toBe(false);
      expect(result?.level).toBe("MUST");
      expect(result?.detail).not.toContain("default token");
    });

    it("reports a description that cannot be fetched", async () => {
      const documents = withOpenApi();
      delete documents[DESCRIPTION];
      const result = byId(await check(documents), `api.description:${DESCRIPTION}`);
      expect(result?.ok).toBe(false);
      expect(result?.detail).toContain("404");
    });
  });

  it("names the transport error and a non-JSON body rather than printing a bare status", async () => {
    const documents = conformingSite();
    documents["https://mcp.shop.test/.well-known/oauth-protected-resource/mcp"] = new Response(
      "<html>sign in</html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
    const result = byId(await check(documents), `api.prm:${MCP}`);
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("(not a JSON object)");
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

describe("version selection from 1.0 (spec 3.4)", () => {
  /** A version one minor newer than the one agents prefer. */
  const NEWER_MINOR = `${NEWEST_VERSION.split(".")[0]}.${Number(NEWEST_VERSION.split(".")[1]) + 1}`;
  /** The newest version this SDK implements that is NOT compatible with the preferred one. */
  const BEHIND = SUPPORTED_PROTOCOL_VERSIONS.find((v) => !compatible(v, NEWEST_VERSION)) ?? "";

  function serving(version: string): Record<string, unknown> {
    const documents = conformingSite();
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = { ...doc, protocol_version: version };
    return documents;
  }

  it("counts a site a minor version ahead as current, not as one no agent can speak", async () => {
    // The rule holds because agents now prefer a 1.x version; before 1.0 every minor broke.
    expect(Number(NEWEST_VERSION.split(".")[0])).toBeGreaterThanOrEqual(1);
    const results = await check(serving(NEWER_MINOR));
    // An agent uses that document as it stands and declares the version it implements, so the site
    // is neither unsupported nor behind.
    expect(byId(results, "discovery.version-supported")?.ok).toBe(true);
    expect(byId(results, "discovery.version-current")?.ok).toBe(true);
  });

  it("still reports a site a major version behind as not current", async () => {
    expect(BEHIND).not.toBe("");
    const results = await check(serving(BEHIND));
    // Usable — an agent speaks it — but a version agents no longer prefer, which is the finding.
    expect(byId(results, "discovery.version-supported")?.ok).toBe(true);
    expect(byId(results, "discovery.version-current")?.ok).toBe(false);
  });

  it("follows a link to a version a minor ahead, which an agent would choose", async () => {
    const documents = serving(BEHIND);
    const doc = documents[`${ORIGIN}/.well-known/poppy.json`] as Record<string, unknown>;
    documents[`${ORIGIN}/.well-known/poppy.json`] = {
      ...doc,
      supported_versions: { [NEWER_MINOR]: `${ORIGIN}/poppy-next.json` },
    };
    documents[`${ORIGIN}/poppy-next.json`] = { ...doc, protocol_version: NEWER_MINOR };
    const results = await check(documents);
    expect(byId(results, "discovery.version-current")?.ok).toBe(true);
  });
});
