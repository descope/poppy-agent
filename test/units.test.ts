import { describe, expect, it } from "vitest";
import {
  agentApproval,
  approvalField,
  approvalHeader,
  approvalMeta,
  clientMetadata,
  isOperationExpired,
  jwks,
  newApprovalReference,
  operationFromToolResult,
  operatorKeyId,
  outcomeFromToolResult,
  parseChallenges,
  parseDecline,
  parseEvent,
  parseOperation,
  parseOperationHeader,
  parseRfc3339,
  PoppyProtocolError,
  renderSummary,
  userApproval,
} from "../src/index.ts";
import { isPrivateHost, withoutTrailingSlashes } from "../src/http.ts";
import { signOperator } from "../src/operator.ts";
import { DelegatedKeys, MAX_DELEGATION_LIFETIME, signSessionJwt } from "../src/session-jwt.ts";
import { decodeJwt, signerFromKey, thumbprint } from "../src/jose.ts";

describe("WWW-Authenticate", () => {
  it("parses several challenges and quoted values", () => {
    const [bearer, dpop] = parseChallenges(
      'Bearer error="insufficient_scope", scope="orders:read orders:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", DPoP algs="ES256", error=invalid_token',
    );
    expect(bearer).toMatchObject({
      scheme: "bearer",
      error: "insufficient_scope",
      scope: "orders:read orders:write",
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
    expect(dpop).toMatchObject({
      scheme: "dpop",
      error: "invalid_token",
      params: { algs: "ES256" },
    });
  });

  it("reads extension_required and escaped quotes", () => {
    const [challenge] = parseChallenges(
      'Bearer error="extension_required", extension="operations", error_description="say \\"hi\\""',
    );
    expect(challenge?.extension).toBe("operations");
    expect(challenge?.params["error_description"]).toBe('say "hi"');
  });

  it("handles a bare scheme", () => {
    expect(parseChallenges("Bearer")).toEqual([
      expect.objectContaining({ scheme: "bearer", error: undefined, scope: undefined }),
    ]);
    expect(parseChallenges(null)).toEqual([]);
  });
});

describe("operations", () => {
  it("renders only emphasis, paragraphs and lists, escaping everything else", () => {
    expect(
      renderSummary(
        "Pay **$70**.\n\n- Item *one*\n- Item two\n\n<img src=x onerror=alert(1)> ![x](https://e.test/x.png)",
      ),
    ).toBe(
      "<p>Pay <strong>$70</strong>.</p><ul><li>Item <em>one</em></li><li>Item two</li></ul>" +
        "<p>&lt;img src=x onerror=alert(1)&gt; ![x](https://e.test/x.png)</p>",
    );
    expect(renderSummary("1. First\n2. Second")).toBe("<ol><li>First</li><li>Second</li></ol>");
  });

  const exchange = parseOperation({
    operation_id: "exc_5Rt2",
    revision: "1791487200-k3Jd9Qx2mW8v",
    summary: "Exchange the jacket.",
    terms: { price_difference: 70 },
    expires_at: "2099-10-08T12:20:00-07:00",
  });

  it("builds a user approval with every member version 3 allows", () => {
    const approval = userApproval(exchange, {
      approvedAt: 1791487260,
      inputType: "tap",
      reference: "apr_01JD8ZK3Q9",
    });
    expect(approval).toEqual({
      operationId: "exc_5Rt2",
      revision: "1791487200-k3Jd9Qx2mW8v",
      approver: "user",
      approvedAt: 1791487260,
      inputType: "tap",
      reference: "apr_01JD8ZK3Q9",
    });
    expect(approvalHeader(approval)).toBe(
      'operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v", approver="user", ' +
        'approved_at=1791487260, input_type="tap", reference="apr_01JD8ZK3Q9"',
    );
    expect(approvalMeta(approval)).toEqual({
      "personalagentprotocol.org/approval": {
        operation_id: "exc_5Rt2",
        revision: "1791487200-k3Jd9Qx2mW8v",
        approver: "user",
        approved_at: 1791487260,
        input_type: "tap",
        reference: "apr_01JD8ZK3Q9",
      },
    });
  });

  it("sends an agent approval without input_type, and refuses one that carries it", () => {
    const approval = agentApproval(exchange, { approvedAt: 1791487255 });
    expect(approvalHeader(approval)).toBe(
      'operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v", approver="agent", ' +
        "approved_at=1791487255",
    );
    // Section 6: input_type MUST NOT be sent with an agent approval.
    expect(() =>
      approvalHeader({ ...approval, inputType: "tap" } as unknown as Parameters<
        typeof approvalHeader
      >[0]),
    ).toThrow(PoppyProtocolError);
  });

  it("sends a version 2 Company only the members version 2 defined", () => {
    const approval = userApproval(exchange, { approvedAt: 1791487260, inputType: "tap" });
    expect(approvalHeader(approval, "2")).toBe(
      'operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v"',
    );
    expect(approvalField(approval, "2")).toEqual({
      operation_id: "exc_5Rt2",
      revision: "1791487200-k3Jd9Qx2mW8v",
    });
    // Version 3 of the same approval is the one that carries approver.
    expect(approvalField(approval, "3")).toMatchObject({ approver: "user" });
  });

  it("refuses approval members a Company must never be sent", () => {
    expect(() =>
      approvalHeader({ operationId: 'a", b="c', revision: "r", approver: "user" }),
    ).toThrow(PoppyProtocolError);
    expect(() =>
      approvalHeader({ ...exchange, approver: "user", reference: "has spaces" } as never),
    ).toThrow(PoppyProtocolError);
    expect(() => userApproval(exchange, { approvedAt: 1.5 })).toThrow(PoppyProtocolError);
    // Random by construction, so the same reference never reaches two Companies (section 6).
    expect(newApprovalReference()).not.toBe(newApprovalReference());
  });

  it("reads an operation from an MCP tool error", () => {
    const operation = operationFromToolResult({
      isError: true,
      content: [{ type: "text", text: "Not done yet." }],
      structuredContent: {
        operation: {
          operation_id: "exc_1",
          revision: "r1",
          summary: "Do it.",
          expires_at: "2000-01-01T00:00:00Z",
        },
      },
    });
    expect(operation?.operationId).toBe("exc_1");
    expect(operation !== undefined && isOperationExpired(operation)).toBe(true);
    expect(operationFromToolResult({ isError: false })).toBeUndefined();
  });

  it("accepts an operation with no summary, which section 3 makes optional", () => {
    const operation = parseOperation({
      operation_id: "exc_1",
      revision: "r1",
      terms: { amount: 1 },
      expires_at: "2099-01-01T00:00:00Z",
    });
    expect(operation.summary).toBeUndefined();
    expect(renderSummary(operation.summary)).toBe("");
  });

  it("refuses an expires_at that names a day the calendar doesn't have", () => {
    // Date.parse("2026-02-30T00:00:00Z") rolls over to 2 March rather than failing, which would give
    // the operation two more days of validity than the Company wrote.
    expect(Number.isNaN(Date.parse("2026-02-30T00:00:00Z"))).toBe(false);
    for (const expires of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:00+24:00",
      "2026-01-01",
      "not a date",
    ]) {
      expect(() =>
        parseOperation({ operation_id: "o", revision: "r", expires_at: expires }),
      ).toThrow(PoppyProtocolError);
    }
    // A leap year keeps 29 February, and an offset is applied rather than ignored.
    expect(parseRfc3339("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
    expect(parseRfc3339("2026-10-08T12:20:00-07:00")).toBe(Date.UTC(2026, 9, 8, 19, 20));
    expect(parseRfc3339("2026-12-31T23:59:60Z")).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
  });

  it("truncates a fractional second rather than rounding it up into the next second", () => {
    // Number(".9999999999999999999") rounds to 1, which would carry into the next second and leave
    // the operation unexpired for a millisecond past the time the Company wrote.
    expect(parseRfc3339("2026-01-01T00:00:00.9999999999999999999Z")).toBe(
      Date.UTC(2026, 0, 1, 0, 0, 0, 999),
    );
    expect(parseRfc3339("2026-01-01T00:00:00.5Z")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0, 500));
    expect(parseRfc3339("2026-01-01T00:00:00.25Z")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0, 250));
    expect(parseRfc3339("2026-01-01T00:00:00.0009Z")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    const operation = parseOperation({
      operation_id: "exc_1",
      revision: "r1",
      expires_at: "2026-01-01T00:00:00.9999999999999999999Z",
    });
    // The millisecond after the truncated expiry is expired, not still valid.
    expect(isOperationExpired(operation, Date.UTC(2026, 0, 1, 0, 0, 1))).toBe(true);
  });

  it("reads a Poppy-Operation header, and only a well-formed one", () => {
    expect(
      parseOperationHeader('sid="ses_Hq3vT8nW2kLm9xRb", ref="exc_5Rt2.1791487200.k3Jd9Qx2mW8v"'),
    ).toEqual({ sid: "ses_Hq3vT8nW2kLm9xRb", ref: "exc_5Rt2.1791487200.k3Jd9Qx2mW8v" });
    for (const header of [
      'sid="ses_1"',
      'ref="exc_1"',
      "sid=ses_1, ref=exc_1",
      'sid="ses_1", ref="has spaces"',
      'sid="ses 1", ref="exc_1"',
      `sid="ses_1", ref="${"a".repeat(2049)}"`,
      null,
      undefined,
    ]) {
      expect(parseOperationHeader(header)).toBeUndefined();
    }
  });

  it("reads a decline and keeps it apart from an operation", () => {
    const declined = parseDecline(
      {
        error: "approval_declined",
        operation_id: "cls_2Wq8",
        revision: "1791487200-p9Lm3Rt6Vx1c",
        reason: "Only the account holder can close this account.",
        alternative: { instructions: "Close it in the Example app." },
      },
      undefined,
    );
    expect(declined).toEqual({
      operationId: "cls_2Wq8",
      revision: "1791487200-p9Lm3Rt6Vx1c",
      reason: "Only the account holder can close this account.",
      alternative: undefined,
    });
    expect(
      outcomeFromToolResult(
        {
          isError: true,
          structuredContent: {
            error: "approval_declined",
            operation_id: "cls_2Wq8",
            revision: "r1",
          },
        },
        undefined as never,
      ),
    ).toMatchObject({ type: "approval_declined" });
    expect(() => parseDecline({ operation_id: "cls_2Wq8" }, undefined)).toThrow(PoppyProtocolError);
  });
});

describe("client metadata", () => {
  it("builds the document with redirect URIs and extensions", () => {
    expect(
      clientMetadata({
        clientId: "https://agent.example/agent.json",
        clientName: "Agent",
        jwksUri: "https://agent.example/jwks.json",
        redirectUris: ["https://agent.example/callback", "http://127.0.0.1/callback"],
        extensions: { operations: { version: "2" } },
      }),
    ).toEqual({
      client_id: "https://agent.example/agent.json",
      client_name: "Agent",
      jwks_uri: "https://agent.example/jwks.json",
      redirect_uris: ["https://agent.example/callback", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "private_key_jwt",
      extensions: { operations: { version: "2" } },
    });
  });

  it("refuses URIs on other hosts", () => {
    const base = {
      clientId: "https://agent.example/agent.json",
      clientName: "A",
      jwksUri: "https://agent.example/j",
    };
    expect(() => clientMetadata({ ...base, jwksUri: "https://cdn.example/j" })).toThrow(
      PoppyProtocolError,
    );
    expect(() => clientMetadata({ ...base, redirectUris: ["https://evil.test/cb"] })).toThrow(
      PoppyProtocolError,
    );
    expect(() => clientMetadata({ ...base, redirectUris: ["http://localhost/cb"] })).toThrow(
      PoppyProtocolError,
    );
  });

  it("publishes only public key members for ES256 and PS384 keys", async () => {
    const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const rsa = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-384",
      },
      true,
      ["sign", "verify"],
    );
    const { keys } = await jwks([
      { publicKey: ec.publicKey, kid: "ec" },
      { publicKey: rsa.publicKey, kid: "rsa" },
    ]);
    expect(keys.map((k) => [k.kty, k.alg])).toEqual([
      ["EC", "ES256"],
      ["RSA", "PS384"],
    ]);
    expect(keys.some((k) => "d" in k || "p" in k)).toBe(false);
  });
});

describe("delegated keys", () => {
  it("issue short-lived delegations that name no User or Company", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const keys = new DelegatedKeys(
      "https://agent.example/agent.json",
      signerFromKey({ privateKey: pair.privateKey, kid: "k1" }),
      10 * MAX_DELEGATION_LIFETIME,
    );
    const jwt = await signSessionJwt(keys, {
      clientId: "https://agent.example/agent.json",
      audience: "https://auth.example.com",
      sid: "sid1",
      userId: "usr_1",
      agentId: "agt_1",
      method: "get",
      url: new URL("https://api.example.com/x?y=1#z"),
      accessToken: undefined,
    });
    const { header, payload } = decodeJwt(jwt);
    expect(header).toMatchObject({ typ: "poppy-session+jwt", alg: "ES256" });
    expect(payload).toMatchObject({
      htm: "GET",
      htu: "https://api.example.com/x",
      agent_id: "agt_1",
    });
    const delegation = decodeJwt(String(header["poppy_dlg"]));
    expect(delegation.header).toMatchObject({
      typ: "poppy-delegation+jwt",
      kid: "k1",
      alg: "ES256",
    });
    const claims = delegation.payload;
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(MAX_DELEGATION_LIFETIME);
    expect(Object.keys(claims).sort()).toEqual(["cnf", "exp", "iat", "iss", "jti"]);
    const cnf = (claims["cnf"] as { jwk: JsonWebKey }).jwk;
    expect(header["kid"]).toBe(await thumbprint(cnf));
    expect("d" in cnf).toBe(false);
  });
});

describe("operator signatures", () => {
  it("signs @authority, poppy-session and authorization with Web Bot Auth parameters", async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const keyId = await operatorKeyId(pair.publicKey);
    const headers = new Headers({ "poppy-session": "eyJ.a.b", authorization: "Bearer at_1" });
    await signOperator(
      {
        privateKey: pair.privateKey,
        keyId,
        signatureAgent: "https://agent.example/.well-known/http-message-signatures-directory",
      },
      new URL("https://api.example.com:443/orders"),
      headers,
    );
    const input = headers.get("signature-input") ?? "";
    expect(input).toMatch(
      /^sig1=\("@authority" "poppy-session" "authorization" "signature-agent"\);created=\d+;expires=\d+;keyid="[^"]+";alg="ed25519";nonce="[^"]+";tag="web-bot-auth"$/,
    );
    const params = input.slice("sig1=".length);
    const base = [
      '"@authority": api.example.com',
      '"poppy-session": eyJ.a.b',
      '"authorization": Bearer at_1',
      '"signature-agent": "https://agent.example/.well-known/http-message-signatures-directory"',
      `"@signature-params": ${params}`,
    ].join("\n");
    const signature = Buffer.from(
      /^sig1=:(.*):$/.exec(headers.get("signature") ?? "")?.[1] ?? "",
      "base64",
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        pair.publicKey,
        signature,
        new TextEncoder().encode(base),
      ),
    ).toBe(true);
  });
});

describe("conversation events", () => {
  it("skips unknown types and normalizes unknown status and responder", () => {
    expect(parseEvent({ id: "e1", type: "future_thing", created_at: "x" })).toBeUndefined();
    expect(
      parseEvent({ id: "e2", type: "state", status: "paused", responder: "robot" }),
    ).toMatchObject({
      status: "working",
      responder: "human",
    });
    expect(parseEvent({ id: "e3", type: "user_requested", reason: "Confirm" })).toMatchObject({
      reason: "Confirm",
    });
    expect(parseEvent({ id: "e4", type: "direct_opened", conversation_id: "cnv_2" })).toMatchObject(
      {
        conversationId: "cnv_2",
      },
    );
  });
});

describe("addresses", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["169.254.169.254", true],
    ["[::1]", true],
    ["[::ffff:7f00:1]", true],
    ["[fd00::1]", true],
    ["example.com", false],
    ["8.8.8.8", false],
  ])("%s private: %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe("signing keys", () => {
  it("refuses an ECDSA key that isn't P-256", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, false, [
      "sign",
    ]);
    expect(() => signerFromKey({ privateKey: pair.privateKey, kid: "k1" })).toThrow("P-256");
  });
});

describe("withoutTrailingSlashes", () => {
  it("drops only trailing slashes, and leaves everything else alone", () => {
    expect(withoutTrailingSlashes("https://example.com/api/")).toBe("https://example.com/api");
    expect(withoutTrailingSlashes("https://example.com/api///")).toBe("https://example.com/api");
    expect(withoutTrailingSlashes("https://example.com/api")).toBe("https://example.com/api");
    expect(withoutTrailingSlashes("/")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
    // Interior slashes stay: only the end is trimmed.
    expect(withoutTrailingSlashes("https://e.test///a///b")).toBe("https://e.test///a///b");
  });

  it("stays linear on the input a backtracking regex would struggle with", () => {
    // `/\/+$/` on a long run of slashes that doesn't end the string is the polynomial case.
    const hostile = `https://example.com/${"/".repeat(50_000)}x`;
    const started = performance.now();
    expect(withoutTrailingSlashes(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
