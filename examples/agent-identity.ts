/**
 * Generates the identity a Personal Agent needs before it can sign anyone in, and writes the two
 * documents you publish plus the private key you don't.
 *
 *   node examples/agent-identity.ts --client-id https://example.com/poppy-agent.json
 *
 * WHY THIS EXISTS. Spec 4.1 makes `client_id` an HTTPS URL that the authorization server fetches —
 * a Client ID Metadata Document — rather than a string handed out by a registration portal. That is
 * what lets an agent reach a Company it has never met. It also means there is nothing to run the
 * agent with until that URL answers, so the first thing anyone testing a site hits is not the
 * protocol at all: it is "what do I put in AGENT_CLIENT_ID?". This answers that in one command.
 *
 * WHAT YOU DO WITH THE OUTPUT:
 *
 *   agent.json       → serve as JSON at exactly the --client-id URL, with no redirect. The server
 *                      fetches this URL literally; a redirect to it, or a trailing-slash variant,
 *                      is a different document and the token request is refused.
 *   agent-jwks.json  → serve at the `jwks_uri` inside agent.json. Spec 4.1 requires it on the same
 *                      host as the client_id, so the host that vouches for the agent's name also
 *                      vouches for its keys.
 *   private-key.jwk  → never publish. This is what signs the agent's token requests
 *                      (private_key_jwt) and its Session headers.
 *
 * Both published files are static and public. A gist, an S3 object or a route that returns a
 * constant are all fine; nothing here needs a server that can think.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientMetadata, jwks, thumbprint } from "../src/index.ts";

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const clientId = flag("client-id");
if (clientId === undefined) {
  // Printed, not thrown: a stack trace answers "is this file broken", and the reader is asking
  // "what do I type". Exit 2 keeps it distinct from a run that happened and found something.
  console.error("--client-id is required: the HTTPS URL you will serve agent.json at.\n");
  console.error(
    "usage: node examples/agent-identity.ts --client-id https://example.com/poppy-agent.json",
  );
  console.error(
    "                                       [--jwks-uri <url>] [--name <name>] [--out <dir>]",
  );
  process.exit(2);
}

// Resolved against the client_id rather than defaulted to a fixed path, because `jwks_uri` has to be
// on the client_id's host (spec 4.1) and this way it lands beside it however the URL is spelled.
const jwksUri = flag("jwks-uri") ?? new URL("agent-jwks.json", clientId).href;
const clientName = flag("name") ?? `Personal Agent at ${new URL(clientId).hostname}`;
const out = flag("out") ?? "poppy-agent-identity";

// ES256. The spec's floor, what every Company's issuer advertises, and small enough that the public
// key fits on a line of a report.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
// The RFC 7638 thumbprint, so the key names itself. A random kid would be just as valid and would
// make two generated identities indistinguishable in a log; this one is derived from the key, so a
// `kid` in a request can be matched against a published key set without being told which is which.
const kid = await thumbprint(await crypto.subtle.exportKey("jwk", pair.publicKey));

const metadata = clientMetadata({ clientId, clientName, jwksUri });
const publicKeys = await jwks([{ publicKey: pair.publicKey, kid }]);
const privateKey = {
  ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
  kid,
  alg: "ES256",
};

// `recursive: true` creates the directory and is also happy when it exists, which is what we want:
// the files below are overwritten on purpose when someone re-runs this after a typo in --client-id.
// Re-running it against a *published* identity is the thing to be careful about — a new key pair
// leaves the old public key on your jwks_uri and every token request signed by the new one is
// refused — so say so rather than guessing which case this is.
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "agent.json"), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(out, "agent-jwks.json"), `${JSON.stringify(publicKeys, null, 2)}\n`);
// 0600: the private key is the agent's whole identity, and this file is the only copy.
writeFileSync(join(out, "private-key.jwk"), `${JSON.stringify(privateKey, null, 2)}\n`, {
  mode: 0o600,
});

console.log(`Wrote ${out}/`);
console.log("");
console.log(`  agent.json        serve at ${clientId}`);
console.log(`  agent-jwks.json   serve at ${jwksUri}`);
console.log("  private-key.jwk   keep secret");
console.log("");
console.log("Then run the agent with:");
console.log("");
console.log(`  export AGENT_CLIENT_ID=${clientId}`);
console.log(`  export AGENT_KEY_JWK="$(cat ${join(out, "private-key.jwk")})"`);
console.log("  node examples/site-agent.ts <your-domain>");
console.log("");
console.log("Re-running this overwrites the key. If agent.json is already published, the new key");
console.log("won't match your jwks_uri until you publish agent-jwks.json again.");
