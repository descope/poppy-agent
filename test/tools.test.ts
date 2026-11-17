import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import {
  PoppyAgent,
  type PoppyTool,
  poppyTools,
  runTool,
  toAiSdkTools,
  toAnthropicTools,
  toMcpTools,
  toOpenAITools,
} from "../src/index.ts";
import { API, CLIENT_ID, MockCompany, type MockOptions } from "./mock-company.ts";

async function setup(options: MockOptions = {}, operationsVersion = "2") {
  const mock = await MockCompany.create(options);
  const agent = new PoppyAgent({
    clientId: CLIENT_ID,
    signingKey: { privateKey: mock.agentKey.privateKey, kid: "k1" },
    fetch: mock.fetch,
    redirectUri: "https://agent.example/callback",
    // The tools handle operations, so the agent declares the extension (Operations section 2).
    extensions: { operations: { version: operationsVersion } },
  });
  const company = await agent.discover("example.com");
  const user = await agent.user(company, "alice");
  // Signs in the way an app would: Direct Sign-In, with the mock approving in the User's place.
  const signIn = async ({ scope }: { scope: string[] }) => {
    const { url } = await user.startDirectSignIn({ scope });
    await agent.completeDirectSignIn(company, await mock.approve(url));
    return true;
  };
  return { mock, agent, company, user, signIn };
}

const names = (tools: PoppyTool[]) => tools.map((t) => t.name);

describe("poppyTools", () => {
  it("offers tools for what the Company supports", async () => {
    const { user, signIn } = await setup();
    expect(names(poppyTools({ user }))).toEqual([
      "poppy_company",
      "poppy_request",
      "poppy_conversation_send",
      "poppy_conversation_read",
      "poppy_conversation_handoff",
      "poppy_conversation_close",
      "poppy_report_unsupported_task",
    ]);
    expect(names(poppyTools({ user, signIn, prefix: "example" }))).toContain("example_sign_in");
    expect(() => poppyTools({ user, prefix: "bad prefix" })).toThrow(TypeError);
  });

  it("describes the Company, its scopes and hints", async () => {
    const { user } = await setup();
    const info = await runTool(poppyTools({ user }), "poppy_company", {});
    expect(info).toMatchObject({
      name: "Example Company",
      domain: "example.com",
      signed_in: false,
      company_agent: true,
      sign_in_types: ["direct", "device", "mediated"],
      scopes: {
        "orders:read": { description: "See your orders", changes: "none", personal_data: true },
      },
    });
  });

  it("reports the scopes a request needs when it can't sign in", async () => {
    const { user } = await setup();
    const result = await runTool(poppyTools({ user }), "poppy_request", {
      url: `${API}/v1/orders`,
    });
    expect(result).toMatchObject({ status: 401, sign_in_required: { scopes: ["orders:read"] } });
  });

  it("signs in through the app's callback and retries", async () => {
    const { user, signIn } = await setup();
    const result = await runTool(poppyTools({ user, signIn }), "poppy_request", {
      url: `${API}/v1/orders`,
    });
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(user.signedIn).toBe(true);
  });

  it("asks the User through the app before an operation, and never otherwise", async () => {
    const { user, signIn } = await setup();
    const request = { method: "POST", url: `${API}/v1/exchanges`, body: { item: "itm_1" } };
    await signIn({ scope: ["orders:write"] });

    const withoutHook = await runTool(poppyTools({ user }), "poppy_request", request);
    expect(withoutHook).toMatchObject({
      performed: false,
      approval_required: { operation_id: "exc_1" },
    });

    const declined = await runTool(
      poppyTools({ user, requestApproval: async () => false }),
      "poppy_request",
      request,
    );
    expect(declined).toMatchObject({ performed: false });

    let shown = "";
    const approved = await runTool(
      poppyTools({
        user,
        requestApproval: async ({ company, summaryHtml }) => {
          shown = `${company.name}: ${summaryHtml}`;
          return true;
        },
      }),
      "poppy_request",
      request,
    );
    expect(approved).toMatchObject({ approved_by: "user", status: 201 });
    expect(shown).toContain("Example Company: <p>Exchange the jacket for <strong>$70</strong>");
  });

  it("carries an agent approval, and reports a decline as final rather than retrying", async () => {
    const { mock, user, signIn } = await setup(
      { version: "1.0", declineAgentApprovals: true },
      "3",
    );
    const request = { method: "POST", url: `${API}/v1/exchanges`, body: { item: "itm_1" } };
    await signIn({ scope: ["orders:write"] });
    const result = await runTool(
      poppyTools({ user, requestApproval: async () => ({ approver: "agent" as const }) }),
      "poppy_request",
      request,
    );
    expect(result).toMatchObject({
      performed: false,
      declined: {
        operation_id: "exc_1",
        reason: "Only the account holder can approve an exchange.",
      },
    });
    expect(String(result["note"])).toContain("Do not send this approval again");
    // Declined once and never sent again (Operations section 7).
    expect(mock.approvals.filter((a) => a?.["approver"] === "agent")).toHaveLength(1);
  });

  it("asks the User about terms that answered an agent approval, and refuses another agent one", async () => {
    const { user, signIn } = await setup({ version: "1.0", exchangeTermsKeepChanging: true }, "3");
    const request = { method: "POST", url: `${API}/v1/exchanges`, body: { item: "itm_1" } };
    await signIn({ scope: ["orders:write"] });
    const asked: boolean[] = [];
    const result = await runTool(
      poppyTools({
        user,
        requestApproval: async ({ mustAskUser }) => {
          asked.push(mustAskUser);
          return { approver: "agent" as const };
        },
      }),
      "poppy_request",
      request,
    );
    // The first round is an agent approval; the new revision that answers it must go to the User
    // (Operations section 5), so the agent approval offered for it is refused.
    expect(asked).toEqual([false, true]);
    expect(result).toMatchObject({
      performed: false,
      approval_required: { operation_id: "exc_1" },
    });
    expect(String(result["note"])).toContain("only the User can approve");
  });

  it("refuses credential headers and hosts the Company didn't list", async () => {
    const { user } = await setup();
    const tools = poppyTools({ user });
    expect(
      await runTool(tools, "poppy_request", {
        url: `${API}/v1/orders`,
        headers: { Authorization: "Bearer stolen" },
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(await runTool(tools, "poppy_request", { url: "https://evil.test/x" })).toMatchObject({
      error: "protocol_error",
    });
  });

  it("never hands the model a token, Session JWT or key", async () => {
    const { user, signIn, mock } = await setup();
    const tools = poppyTools({ user, signIn });
    const results = [
      await runTool(tools, "poppy_company", {}),
      await runTool(tools, "poppy_request", { url: `${API}/v1/orders` }),
      await runTool(tools, "poppy_sign_in", { scopes: ["orders:read"] }),
    ];
    const text = JSON.stringify(results);
    const secrets = [
      ...mock.accessTokens.keys(),
      ...mock.refreshTokens.keys(),
      ...mock.requests.flatMap((r) => [r.headers.get("poppy-session"), r.headers.get("dpop")]),
    ].filter((value): value is string => typeof value === "string" && value !== "");
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});

describe("framework adapters", () => {
  it("builds Vercel AI SDK tools that run", async () => {
    const { user } = await setup();
    const tools = toAiSdkTools(poppyTools({ user }), { tool, jsonSchema });
    const company = tools["poppy_company"] as unknown as {
      description: string;
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    expect(company.description).toContain("Example Company");
    const result = await company.execute({}, { toolCallId: "call_1", messages: [] });
    expect(result).toMatchObject({ domain: "example.com" });
  });

  it("builds Anthropic and OpenAI tool definitions", async () => {
    const { user } = await setup();
    const tools = poppyTools({ user });
    expect(toAnthropicTools(tools)[1]).toMatchObject({
      name: "poppy_request",
      input_schema: { type: "object", required: ["url"] },
    });
    expect(toOpenAITools(tools)[1]).toMatchObject({
      type: "function",
      function: { name: "poppy_request", parameters: { required: ["url"] } },
    });
    expect(await runTool(tools, "nope", {})).toMatchObject({ error: "unknown_tool" });
  });

  it("answers MCP tools/list and tools/call", async () => {
    const { user } = await setup();
    const mcp = toMcpTools(poppyTools({ user }));
    expect(mcp.listTools().tools[0]).toMatchObject({ name: "poppy_company" });
    const call = await mcp.callTool({
      name: "poppy_request",
      arguments: { url: "https://evil.test" },
    });
    expect(call.isError).toBe(true);
    expect(JSON.parse(call.content[0]?.text ?? "{}")).toEqual(call.structuredContent);
  });
});
