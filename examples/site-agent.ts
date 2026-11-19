/**
 * Runs a real Personal Agent against a real site and reports, step by step, how far it got.
 *
 *   AGENT_CLIENT_ID=https://example.com/poppy-agent.json \
 *   AGENT_KEY_JWK="$(cat poppy-agent-identity/private-key.jwk)" \
 *     node examples/site-agent.ts your-domain.com
 *
 * WHAT THIS IS FOR, AND WHAT IT ISN'T. `poppy-conformance site <domain>` reads your published
 * documents and tells you whether they say the right things. It signs nobody in, because it can't:
 * it has no agent identity and no human at the keyboard. So a site can pass every document check
 * and still be unusable — the issuer refuses the agent, the scope isn't grantable, the browser-join
 * endpoint 404s, the session cookie never arrives. This is the other half: one run of the actual
 * flow, by an actual agent, with you approving it on your phone.
 *
 * Run the document checker first. A failure there explains a failure here, and this tool stops at
 * the first step that can't proceed rather than guessing.
 *
 * WHAT IT DOES, IN THE ORDER AN AGENT DOES IT:
 *
 *   1. Discovery — poppy.json, the domain's protected-resource metadata, the issuer's metadata,
 *      and the link between them (spec 3).
 *   2. Reports what the site offers: version, surfaces, scopes, which sign-in methods are live.
 *   3. Device Sign-In (spec 4.3) — prints a URL and a code for you to approve.
 *   4. The browser join (spec 6), if the site lists `web.browser_session_endpoint`.
 *   5. One signed-in page fetch, to show the session is real.
 *
 * Options:
 *   --scope <scope>   Request this scope. Repeat for several. Defaults to poppy:browser-sign-in
 *                     when the site offers it, else every scope the site lists.
 *   --page <url>      The page to fetch at step 5. Defaults to the site's root.
 *   --signed-out      Join the browser signed out, skipping steps 3 and 4's sign-in. Use this to
 *                     check the join itself works before any account exists.
 */
import {
  BROWSER_SIGN_IN_SCOPE,
  PoppyAgent,
  PoppyError,
  type Session,
  supportedScopes,
} from "../src/index.ts";

const argv = process.argv.slice(2);
function flags(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === `--${name}`) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      values.push(value);
    } else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3));
  }
  return values;
}

/**
 * The one bare argument. Walked rather than filtered, so the value of a flag is never mistaken for
 * the domain: `--scope orders:read example.com` has two bare-looking words and only one of them is
 * the site. Getting that wrong would point the whole run at `orders:read`.
 */
function bareArgument(): string | undefined {
  const takesValue = new Set(["scope", "page"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) return arg;
    const name = arg.slice(2).split("=")[0] ?? "";
    if (takesValue.has(name) && !arg.includes("=")) i++;
  }
  return undefined;
}

/**
 * Prints and exits 2, rather than throwing. A stack trace is the right answer for a bug in this
 * file and the wrong one for "you forgot the domain": the reader is setting a site up, not
 * debugging Node, and the trace buries the one line that tells them what to type.
 */
function usage(message: string): never {
  console.error(`${message}\n`);
  console.error("usage: node examples/site-agent.ts <domain> [--scope <scope>] [--page <url>]");
  console.error("                                           [--signed-out]");
  process.exit(2);
}

const website = bareArgument();
const signedOutOnly = argv.includes("--signed-out");
if (website === undefined) usage("No domain given.");

const clientId = process.env["AGENT_CLIENT_ID"];
const keyJwk = process.env["AGENT_KEY_JWK"];
if (clientId === undefined || keyJwk === undefined) {
  usage(
    "Set AGENT_CLIENT_ID and AGENT_KEY_JWK first. Generate both with:\n" +
      "  node examples/agent-identity.ts --client-id https://your-host/poppy-agent.json",
  );
}

/** Printed as the run goes, so a run that stops early still says where. */
let failed = false;
const ok = (step: string, detail: string) => console.log(`  ✓ ${step.padEnd(22)} ${detail}`);
const no = (step: string, detail: string) => {
  failed = true;
  console.log(`  ✗ ${step.padEnd(22)} ${detail}`);
};
const skip = (step: string, detail: string) => console.log(`  – ${step.padEnd(22)} ${detail}`);
/**
 * The code and the message, unless the message already opens with the code — an issuer that returns
 * `{"error":"invalid_request","error_description":"invalid_request: ..."}` would otherwise be
 * reported as "invalid_request: invalid_request: ...", which reads like two failures rather than one.
 */
const reason = (error: unknown) => {
  if (!(error instanceof PoppyError)) return String(error);
  return error.message.startsWith(error.error) ? error.message : `${error.error}: ${error.message}`;
};

const privateKey = await crypto.subtle.importKey(
  "jwk",
  JSON.parse(keyJwk) as JsonWebKey,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);
// The `kid` has to name a key published at your `jwks_uri`, so it comes from the key file rather
// than a constant here: a fixed "agent-key-1" would be wrong for anyone whose key set says otherwise.
const kid = (JSON.parse(keyJwk) as { kid?: string }).kid;
if (kid === undefined) usage("AGENT_KEY_JWK has no `kid`. Regenerate it with agent-identity.ts.");

const agent = new PoppyAgent({ clientId, signingKey: { privateKey, kid } });

console.log(`\n${website}\n`);

// ---------------------------------------------------------------- 1. discovery
const company = await agent.discover(website).catch((error: unknown) => {
  no("discovery", reason(error));
  console.log(
    `\nDiscovery is where every other step starts, so this run stops here.\n` +
      `Run \`npx @descope/poppy-conformance site ${website}\` — it checks each document in the\n` +
      `chain separately and names the one that broke.\n`,
  );
  process.exit(1);
});

ok("discovery", `${company.name} — Poppy ${company.protocolVersion}`);

// ---------------------------------------------------------------- 2. what the site offers
const surfaces = [
  company.webDisabled ? undefined : "website",
  company.apis.length > 0 ? `${company.apis.length} API(s)` : undefined,
  company.conversationProtocols.length > 0 ? "Company Agent" : undefined,
].filter((surface) => surface !== undefined);
ok("surfaces", surfaces.length === 0 ? "none — nothing for an agent to use" : surfaces.join(", "));

const methods = [
  company.signIn.device ? "device" : undefined,
  company.signIn.direct ? "direct" : undefined,
  company.signIn.mediated ? "mediated" : undefined,
].filter((method) => method !== undefined);
if (company.signIn.disabled) no("sign-in", "auth.disabled — this site refuses agent sign-in");
else if (methods.length === 0) no("sign-in", "the issuer advertises no grant an agent can use");
else ok("sign-in", `${methods.join(", ")} — issuer ${company.identifier}`);

const offered = supportedScopes(company);
ok("scopes", offered.length === 0 ? "none listed" : offered.join(", "));

const endpoint = company.browserSessionEndpoint;
if (endpoint === undefined)
  skip("browser join", "no web.browser_session_endpoint — agents browse signed out only");
else ok("browser join", endpoint);

// ---------------------------------------------------------------- 3. sign in
const user = await agent.user(company, "site-agent-check");
let session: Session = user.session();

const requested = flags("scope");
const scope =
  requested.length > 0
    ? requested
    : offered.includes(BROWSER_SIGN_IN_SCOPE)
      ? [BROWSER_SIGN_IN_SCOPE]
      : Object.keys(company.scopes);

if (signedOutOnly) {
  skip("sign-in run", "--signed-out");
} else if (!company.signIn.device) {
  skip(
    "sign-in run",
    "needs Device Sign-In; this site offers only " + (methods.join(", ") || "nothing"),
  );
} else if (scope.length === 0) {
  skip("sign-in run", "the site lists no scopes to ask for");
} else {
  try {
    const signIn = await user.startDeviceSignIn({ scope });
    console.log(`\n  Approve ${company.name} (${company.domain}) for: ${scope.join(" ")}`);
    console.log(`  Open ${signIn.verificationUriComplete ?? signIn.verificationUri}`);
    if (signIn.verificationUriComplete === undefined) console.log(`  and enter ${signIn.userCode}`);
    console.log("  Waiting…\n");
    const granted = await signIn.wait();
    // The scopes granted, not the scopes asked for: an issuer may give fewer, and a browser join
    // that then fails for want of poppy:browser-sign-in is explained by this line, not by step 4.
    ok("signed in", `granted ${granted.scope.join(" ") || "(no scopes)"}`);
    session = user.session();
  } catch (error) {
    no("signed in", reason(error));
  }
}

// ---------------------------------------------------------------- 4. the browser join
/**
 * The agent's own browser, as three fetches with a cookie jar.
 *
 * A JAR, NOT BARE FETCH. Spec 6 ties the one-time code to the browser that was handed it, with a
 * cookie set on the page and sent back with the form. `fetch` in Node keeps no cookies, so without
 * this the submit arrives as a different browser and the join is refused — on a correctly built
 * site, which is the worst kind of false failure for a tool whose job is to find real ones.
 */
class FetchBrowser {
  readonly #cookies = new Map<string, string>();
  #page = "";
  #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  #header(): Record<string, string> {
    if (this.#cookies.size === 0) return {};
    return {
      cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    };
  }

  #keep(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (pair === undefined || index <= 0) continue;
      this.#cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  async open(): Promise<number> {
    const response = await fetch(this.#url, { headers: this.#header() });
    this.#keep(response);
    this.#page = await response.text();
    return response.status;
  }

  readCode(): string | undefined {
    // The hidden field the page carries, per spec 6. Matched on either attribute order, because a
    // template that writes `value` before `name` is still a conforming page.
    return (
      /name="code"\s+value="([^"]+)"/.exec(this.#page)?.[1] ??
      /value="([^"]+)"\s+name="code"/.exec(this.#page)?.[1]
    );
  }

  async submit(code: string): Promise<{ status: number; cookies: string[] }> {
    const response = await fetch(`${this.#url.replace(/\/$/, "")}/submit`, {
      method: "POST",
      headers: { ...this.#header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }).toString(),
      redirect: "manual",
    });
    this.#keep(response);
    const names = response.headers
      .getSetCookie()
      .map((raw) => raw.split("=")[0] ?? "")
      .filter((name) => name !== "");
    await response.body?.cancel();
    return { status: response.status, cookies: names };
  }
}

if (endpoint !== undefined) {
  const browser = new FetchBrowser(endpoint);
  try {
    const status = await browser.open();
    const code = browser.readCode();
    if (status !== 200) no("join: page", `GET ${endpoint} → ${status}`);
    else if (code === undefined)
      no("join: page", "200, but the page carries no hidden `code` field (spec 6)");
    else {
      ok("join: page", "a one-time code and its cookie");
      let signedOut = signedOutOnly;
      try {
        await session.authorizeBrowserCode(code, signedOut ? { signedOut: true } : {});
      } catch (error) {
        // From 0.4 a signed-in join needs poppy:browser-sign-in. Without it the join still works
        // signed out, and saying which of the two happened is the whole point of this step.
        if (!(error instanceof PoppyError) || error.error !== "insufficient_scope") throw error;
        signedOut = true;
        await session.authorizeBrowserCode(code, { signedOut: true });
      }
      ok("join: authorized", signedOut ? "signed out" : `signed in with ${BROWSER_SIGN_IN_SCOPE}`);
      const submitted = await browser.submit(code);
      if (submitted.status >= 400) no("join: submit", `→ ${submitted.status}`);
      else if (submitted.cookies.length === 0)
        no(
          "join: submit",
          `→ ${submitted.status}, but no cookie was set, so the browser is still a stranger`,
        );
      else ok("join: submit", `→ ${submitted.status}, set ${submitted.cookies.join(", ")}`);
    }
  } catch (error) {
    no("join", reason(error));
  }
}

// ---------------------------------------------------------------- 5. browse it
const page = flags("page")[0] ?? `https://${company.domain}/`;
try {
  const response = await session.fetchPage(page);
  await response.body?.cancel();
  if (response.ok) ok("page fetch", `${page} → ${response.status}`);
  else no("page fetch", `${page} → ${response.status}`);
} catch (error) {
  no("page fetch", reason(error));
}

console.log(
  failed
    ? "\nSomething above failed. Each ✗ names the step; the spec section is in the comments of this file.\n"
    : "\nEvery step an agent takes against this site worked.\n",
);
process.exitCode = failed ? 1 : 0;
