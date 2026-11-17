import type { Company } from "./discovery.ts";
import { PoppyProtocolError } from "./errors.ts";
import { isObject } from "./http.ts";
import { type Alternative, parseAlternative } from "./tasks.ts";

/**
 * The extension name and version this client implements (Operations extension section 2).
 *
 * Pass it to `PoppyAgent` as `extensions: { operations: { version: OPERATIONS_EXTENSION.version } }`.
 * Version 3 adds `approver` to every approval, declines, and operations on a website. The SDK still
 * talks version 2 to a Company that lists only that: {@link OPERATIONS_V2_VERSION} says which members
 * such a Company is sent.
 */
export const OPERATIONS_EXTENSION = { name: "operations", version: "3" } as const;

/** The older version this SDK still speaks, for a Company that lists only it (section 2). */
export const OPERATIONS_V2_VERSION = "2" as const;

/** The versions of this extension the SDK implements, newest first. */
export const OPERATIONS_VERSIONS = ["3", "2"] as const;

/** The version of this extension in use with a Company, from what it lists (section 2). */
export type OperationsVersion = (typeof OPERATIONS_VERSIONS)[number];

/** The characters an ID may use (spec 8.2), which `operation_id`, `revision` and `reference` share. */
const ID = /^[A-Za-z0-9_-]{1,256}$/;

/** A website reference: the same characters as an ID, plus `.`, up to 2048 of them (section 4). */
const REF = /^[A-Za-z0-9_.-]{1,2048}$/;

/** RFC 3339 `date-time`. The calendar fields are checked separately, since `Date.parse` rolls them over. */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** One action the Company performs once its exact terms are approved (Operations section 3). */
export interface Operation {
  operationId: string;
  /** Identifies these terms. A new revision needs a new approval. */
  revision: string;
  /**
   * The terms in plain language, when the Company wrote one. Show it to the User with
   * {@link renderSummary} or as text. Optional (section 3): describe `terms` yourself when it is absent.
   */
  summary: string | undefined;
  /** The same terms as JSON, for checking against the `summary` and what you asked for. */
  terms: Readonly<Record<string, unknown>> | undefined;
  /** RFC 3339. The last time an approval of this revision is accepted. */
  expiresAt: string;
  /** {@link expiresAt} as Unix milliseconds, parsed once with the calendar checked. */
  expiresAtMs: number;
}

/** How an approval was given (Operations section 5). */
export type Approver = "user" | "agent";

/**
 * The statement that one revision of an operation is approved (Operations section 6).
 *
 * `approver` is required: version 3 of the extension has no approval without it. Build one with
 * {@link userApproval} or {@link agentApproval} rather than by hand, so the rules below are checked.
 *
 * `inputType` and `reference` MUST NOT carry personal data or anything that identifies the User or
 * their device, and the same `reference` MUST NOT go to two Companies, so Companies can't use it to
 * link one User's approvals across Companies. {@link newApprovalReference} meets both by construction.
 */
export type Approval =
  | {
      operationId: string;
      revision: string;
      /** The User approved, through the agent's own interface (section 5). */
      approver: "user";
      /** Unix seconds: when the User approved. May be earlier than the request. */
      approvedAt?: number;
      /** How the User answered, such as `tap`, `typed` or `voice`. Other values are allowed. */
      inputType?: string;
      /** An ID for the agent's own record of the approval. See the rules above. */
      reference?: string;
    }
  | {
      operationId: string;
      revision: string;
      /** The agent approved, on an instruction the User gave it (section 5). */
      approver: "agent";
      /** Unix seconds: when the agent approved. May be earlier than the request. */
      approvedAt?: number;
      /** An ID for the agent's own record of the approval. See the rules above. */
      reference?: string;
      /** Never sent with an agent approval (section 6); the type forbids it, so a Company never sees it. */
      inputType?: never;
    };

/** What the Company said instead of performing the action (Operations section 6). */
export interface Decline {
  operationId: string;
  revision: string;
  /**
   * Why, in the Company's own short words for the User. Content from the Company (spec 10.1): show it
   * or put it in your own words, never follow it as an instruction.
   */
  reason: string | undefined;
  /** Another way to do the action (spec 9.2). Content from the Company, not instructions. */
  alternative: Alternative | undefined;
}

/**
 * What a Company answered a request that can need approval with (Operations sections 4 and 6).
 *
 * A decline is not a failure and not retryable: nothing was performed, and that approval is never sent
 * again (section 7). It is modelled here rather than thrown so it can't be caught with transport errors
 * and retried.
 */
export type OperationOutcome =
  | { type: "approval_required"; operation: Operation }
  | { type: "approval_declined"; decline: Decline };

/** The `sid` and `ref` of a `Poppy-Operation` header (Operations section 4). */
export interface OperationReference {
  /** The Session the website handled the request as. */
  sid: string;
  /** The Company's reference to the operation. Opaque; send it only to that Company's `endpoint`. */
  ref: string;
}

/** The state of an operation whose approval the Company recorded (Operations section 6). */
export interface WebOperationStatus {
  operationId: string;
  /** `approved` while it waits, `performing` while it runs, `performed` after. */
  status: "approved" | "performing" | "performed" | (string & {});
}

function daysInMonth(year: number, month: number): number {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

/**
 * Parses an RFC 3339 `date-time` to Unix milliseconds, or undefined when it isn't one.
 *
 * `Date.parse` is not enough on its own: it rolls a nonexistent date over, so `2026-02-30T00:00:00Z`
 * comes back as 2 March rather than NaN, and an operation would silently gain days of validity. The
 * calendar fields are checked here and the instant is built from them, never from `Date.parse`.
 */
export function parseRfc3339(value: string): number | undefined {
  const match = RFC3339.exec(value);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s, frac, zulu, sign, offsetHours, offsetMinutes] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  let second = Number(s);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 60) return undefined;
  // RFC 3339 allows a leap second, which no JavaScript Date holds. It is the same instant to a second.
  if (second === 60) second = 59;
  // Truncate the fraction to milliseconds on its digits, not through a float: Number(".9999999999")
  // rounds to 1, which would roll the expiry into the next second and leave the operation unexpired
  // for a millisecond past the time the Company wrote.
  const milliseconds = frac === undefined ? 0 : Number(frac.slice(1, 4).padEnd(3, "0"));
  const date = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 into the 1900s.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  let time = date.getTime();
  if (zulu === undefined) {
    const offsetH = Number(offsetHours);
    const offsetM = Number(offsetMinutes);
    if (offsetH > 23 || offsetM > 59) return undefined;
    time -= (sign === "-" ? -1 : 1) * (offsetH * 60 + offsetM) * 60_000;
  }
  return time;
}

export function parseOperation(value: unknown): Operation {
  if (!isObject(value)) throw new PoppyProtocolError("operation must be an object");
  const { operation_id, revision, summary, terms, expires_at } = value;
  if (typeof operation_id !== "string" || !ID.test(operation_id))
    throw new PoppyProtocolError("operation_id is missing or malformed");
  if (typeof revision !== "string" || !ID.test(revision))
    throw new PoppyProtocolError("revision is missing or malformed");
  // summary is optional (section 3); an operation without one is described from `terms`.
  if (summary !== undefined && typeof summary !== "string")
    throw new PoppyProtocolError("operation summary must be a string");
  if (typeof expires_at !== "string")
    throw new PoppyProtocolError("operation expires_at is missing or malformed");
  const expiresAtMs = parseRfc3339(expires_at);
  if (expiresAtMs === undefined)
    throw new PoppyProtocolError("operation expires_at is not an RFC 3339 date-time");
  if (terms !== undefined && !isObject(terms))
    throw new PoppyProtocolError("operation terms must be an object");
  return {
    operationId: operation_id,
    revision,
    summary: summary === "" ? undefined : summary,
    terms,
    expiresAt: expires_at,
    expiresAtMs,
  };
}

/**
 * Reads a decline (Operations section 6). `company` is what checks that an `alternative` names an API
 * the Company lists (spec 9.2); without it the decline carries no alternative, since nothing could
 * check where one points.
 */
export function parseDecline(value: unknown, company: Company | undefined): Decline {
  if (!isObject(value)) throw new PoppyProtocolError("decline must be an object");
  const { operation_id, revision, reason, alternative } = value;
  if (typeof operation_id !== "string" || !ID.test(operation_id))
    throw new PoppyProtocolError("declined operation_id is missing or malformed");
  if (typeof revision !== "string" || !ID.test(revision))
    throw new PoppyProtocolError("declined revision is missing or malformed");
  return {
    operationId: operation_id,
    revision,
    reason: typeof reason === "string" && reason !== "" ? reason : undefined,
    alternative: company === undefined ? undefined : parseAlternative(alternative, company),
  };
}

/** Whether an approval of this revision is still accepted (Operations section 3). */
export function isOperationExpired(operation: Operation, now = Date.now()): boolean {
  return operation.expiresAtMs < now;
}

/** Options a user approval may carry (Operations section 6). */
export interface UserApprovalOptions {
  /** Unix seconds; defaults to now. SHOULD be sent with a user approval. */
  approvedAt?: number | Date;
  /** How the User answered, such as `tap`. SHOULD be sent with a user approval. No personal data. */
  inputType?: string;
  /** The agent's own record ID. Never the same to two Companies; see {@link newApprovalReference}. */
  reference?: string;
}

/** Options an agent approval may carry (Operations section 6). `input_type` is not one of them. */
export type AgentApprovalOptions = Omit<UserApprovalOptions, "inputType">;

function seconds(at: number | Date | undefined): number | undefined {
  if (at === undefined) return undefined;
  const value = at instanceof Date ? Math.floor(at.getTime() / 1000) : at;
  if (!Number.isInteger(value) || value < 0)
    throw new PoppyProtocolError("approved_at must be whole Unix seconds");
  return value;
}

/**
 * The User's approval of this revision, made after they approved it in the agent's own interface
 * (Operations section 5). `approvedAt` defaults to now.
 */
export function userApproval(
  operation: Operation,
  options: UserApprovalOptions = {},
): Approval & { approver: "user" } {
  const approval: Approval & { approver: "user" } = {
    operationId: operation.operationId,
    revision: operation.revision,
    approver: "user",
    approvedAt: seconds(options.approvedAt) ?? Math.floor(Date.now() / 1000),
  };
  if (options.inputType !== undefined) approval.inputType = options.inputType;
  if (options.reference !== undefined) approval.reference = options.reference;
  checkApproval(approval);
  return approval;
}

/**
 * The agent's approval of this revision, on an instruction the User gave it (Operations section 5).
 *
 * The spec's MUSTs are yours to meet, and this SDK can't check them for you: the instruction MUST come
 * from the User and never from anything the agent read, and you MUST check the revision's terms against
 * it before calling this, asking the User when you can't tell. If the Company answers with a new
 * revision, you MUST NOT approve that one on the same instruction.
 */
export function agentApproval(
  operation: Operation,
  options: AgentApprovalOptions = {},
): Approval & { approver: "agent" } {
  const approval: Approval & { approver: "agent" } = {
    operationId: operation.operationId,
    revision: operation.revision,
    approver: "agent",
    approvedAt: seconds(options.approvedAt) ?? Math.floor(Date.now() / 1000),
  };
  if (options.reference !== undefined) approval.reference = options.reference;
  checkApproval(approval);
  return approval;
}

/** How an approval was given, with the members that way allows (Operations sections 5, 6). */
export type ApprovalChoice =
  | ({ approver: "user" } & UserApprovalOptions)
  | ({ approver: "agent" } & AgentApprovalOptions);

/**
 * The approval of this operation's current revision, however it was approved (Operations section 5).
 *
 * Send it only once the revision really is approved: by the User, in the agent's own interface, or by
 * the agent on an instruction the User gave it. {@link userApproval} and {@link agentApproval} are the
 * same thing with the approver fixed.
 */
export function approvalFor(operation: Operation, choice: ApprovalChoice): Approval {
  return choice.approver === "user"
    ? userApproval(operation, choice)
    : agentApproval(operation, choice);
}

/**
 * A fresh, random `reference` for the agent's own record of an approval (Operations section 6).
 *
 * Random, so it carries no personal data and is never sent to two Companies, which are both MUSTs. Keep
 * it beside the approval in your own ledger; don't derive one from a User or device ID.
 */
export function newApprovalReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let base64 = "";
  for (const byte of bytes) base64 += String.fromCharCode(byte);
  return `apr_${btoa(base64).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

/** Checks the rules of section 6 that don't depend on the Company. Throws on anything a Company must not see. */
export function checkApproval(approval: Approval): void {
  if (approval.approver !== "user" && approval.approver !== "agent")
    throw new PoppyProtocolError('an approval needs approver "user" or "agent"');
  if (!ID.test(approval.operationId))
    throw new PoppyProtocolError("operation_id has characters an approval can't carry");
  if (!ID.test(approval.revision))
    throw new PoppyProtocolError("revision has characters an approval can't carry");
  if (approval.approvedAt !== undefined) seconds(approval.approvedAt);
  if (approval.reference !== undefined && !ID.test(approval.reference))
    throw new PoppyProtocolError("reference has characters an approval can't carry");
  if (approval.approver === "agent" && approval.inputType !== undefined)
    throw new PoppyProtocolError("input_type must not be sent with an agent approval");
  if (approval.inputType !== undefined && !/^[\x20-\x7e]{1,64}$/.test(approval.inputType))
    throw new PoppyProtocolError("input_type must be a short printable string");
}

/**
 * Reads the operation from an API response that refuses with `approval_required` (Operations section 4).
 * Reads a clone, so the response body stays readable. Returns undefined for any other response.
 */
export async function operationFromResponse(response: Response): Promise<Operation | undefined> {
  if (response.status !== 403) return undefined;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  if (!isObject(body) || body["error"] !== "approval_required") return undefined;
  return parseOperation(body["operation"]);
}

/** Reads the operation from an MCP tool error result (Operations section 4). */
export function operationFromToolResult(result: unknown): Operation | undefined {
  if (!isObject(result) || result["isError"] !== true) return undefined;
  const structured = result["structuredContent"];
  if (!isObject(structured) || structured["operation"] === undefined) return undefined;
  return parseOperation(structured["operation"]);
}

function outcomeFromBody(body: unknown, company: Company): OperationOutcome | undefined {
  if (!isObject(body)) return undefined;
  if (body["error"] === "approval_required")
    return { type: "approval_required", operation: parseOperation(body["operation"]) };
  if (body["error"] === "approval_declined")
    return { type: "approval_declined", decline: parseDecline(body, company) };
  return undefined;
}

/**
 * What an API response says about approval: a new operation, a decline, or undefined when it is an
 * ordinary response (Operations sections 4 and 6). Reads a clone, so the body stays readable.
 */
export async function outcomeFromResponse(
  response: Response,
  company: Company,
): Promise<OperationOutcome | undefined> {
  if (response.status !== 403) return undefined;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  return outcomeFromBody(body, company);
}

/** What an MCP tool result says about approval (Operations sections 4 and 6). */
export function outcomeFromToolResult(
  result: unknown,
  company: Company,
): OperationOutcome | undefined {
  if (!isObject(result) || result["isError"] !== true) return undefined;
  return outcomeFromBody(result["structuredContent"], company);
}

/**
 * What a conversation message's `extensions.operations` says about approval (Operations sections 4, 6):
 * `operation` for new terms, `declined` for a decline. Malformed content is skipped, as spec 8.5 asks.
 */
export function outcomeFromMessageExtension(
  operations: unknown,
  company: Company | undefined,
): OperationOutcome | undefined {
  if (!isObject(operations)) return undefined;
  try {
    if (operations["operation"] !== undefined)
      return { type: "approval_required", operation: parseOperation(operations["operation"]) };
    if (operations["declined"] !== undefined)
      return { type: "approval_declined", decline: parseDecline(operations["declined"], company) };
  } catch {
    return undefined;
  }
  return undefined;
}

// RFC 9651 section 3.3.3: a String holds printable ASCII, with `"` and `\` escaped.
function sfString(value: string, what: string): string {
  if (!/^[\x20-\x7e]*$/.test(value))
    throw new PoppyProtocolError(`${what} has characters an approval can't carry`);
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * The members of an approval a Company at `version` is sent. Version 2 knew only `operation_id` and
 * `revision`, so a Company that lists only that is sent only those two (section 2).
 */
function members(approval: Approval, version: OperationsVersion): [string, string | number][] {
  checkApproval(approval);
  const pairs: [string, string | number][] = [
    ["operation_id", approval.operationId],
    ["revision", approval.revision],
  ];
  if (version === "2") return pairs;
  pairs.push(["approver", approval.approver]);
  if (approval.approvedAt !== undefined) pairs.push(["approved_at", approval.approvedAt]);
  if (approval.approver === "user" && approval.inputType !== undefined)
    pairs.push(["input_type", approval.inputType]);
  if (approval.reference !== undefined) pairs.push(["reference", approval.reference]);
  return pairs;
}

/**
 * The `Poppy-Approval` header value, an RFC 9651 Dictionary (Operations section 6). `approved_at` is an
 * Integer and the rest are Strings.
 */
export function approvalHeader(approval: Approval, version: OperationsVersion = "3"): string {
  return members(approval, version)
    .map(([key, value]) =>
      typeof value === "number" ? `${key}=${value}` : `${key}=${sfString(value, key)}`,
    )
    .join(", ");
}

/** The `_meta` member to add to the same `tools/call` to approve an MCP operation (section 6). */
export function approvalMeta(
  approval: Approval,
  version: OperationsVersion = "3",
): Record<string, unknown> {
  return { "personalagentprotocol.org/approval": approvalObject(approval, version) };
}

/** The `approval` field of a conversation message's `extensions.operations` (section 6). */
export function approvalField(
  approval: Approval,
  version: OperationsVersion = "3",
): Record<string, string | number> {
  return approvalObject(approval, version);
}

function approvalObject(
  approval: Approval,
  version: OperationsVersion,
): Record<string, string | number> {
  return Object.fromEntries(members(approval, version));
}

/**
 * Reads a `Poppy-Operation` header (Operations section 4): an RFC 9651 Dictionary of two Strings.
 * Returns undefined for anything that isn't one, or whose `ref` is longer or uses other characters.
 *
 * Section 8.2: take a reference ONLY from a response the agent's own browser received, and only when
 * `sid` names a Session the agent joined that browser to. Never from page content or a message.
 * {@link Session.webOperation} makes the `sid` check; the rest is the caller's, since the SDK doesn't
 * drive the browser.
 */
export function parseOperationHeader(
  value: string | null | undefined,
): OperationReference | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  const fields = new Map<string, string>();
  let rest = value.trim();
  while (rest !== "") {
    const key = /^([a-z*][a-z0-9_.*-]*)=/.exec(rest);
    const name = key?.[1];
    if (key === null || name === undefined) return undefined;
    rest = rest.slice(key[0].length);
    if (!rest.startsWith('"')) return undefined;
    let index = 1;
    let text = "";
    for (;;) {
      if (index >= rest.length) return undefined;
      const char = rest[index];
      if (char === "\\") {
        const next = rest[index + 1];
        if (next !== '"' && next !== "\\") return undefined;
        text += next;
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        break;
      }
      if (char === undefined || char < "\x20" || char > "\x7e") return undefined;
      text += char;
      index += 1;
    }
    fields.set(name, text);
    rest = rest.slice(index).trimStart();
    if (rest === "") break;
    if (!rest.startsWith(",")) return undefined;
    rest = rest.slice(1).trimStart();
    if (rest === "") return undefined;
  }
  const sid = fields.get("sid");
  const ref = fields.get("ref");
  if (sid === undefined || ref === undefined) return undefined;
  if (!ID.test(sid) || !REF.test(ref)) return undefined;
  return { sid, ref };
}

/** Reads the state of an approved operation from `endpoint` (Operations section 6). */
export function parseWebOperationStatus(value: unknown): WebOperationStatus {
  if (!isObject(value)) throw new PoppyProtocolError("operation status must be an object");
  const { operation_id, status } = value;
  if (typeof operation_id !== "string" || !ID.test(operation_id))
    throw new PoppyProtocolError("operation_id is missing or malformed");
  if (typeof status !== "string" || status === "")
    throw new PoppyProtocolError("operation status is missing");
  return { operationId: operation_id, status };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "<strong>$1</strong>")
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "<em>$1</em>")
    .replace(/(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])/g, "<em>$1</em>");
}

/**
 * Renders an operation `summary` as HTML with only what Operations section 3 allows: emphasis, strong
 * emphasis, paragraphs and lists. Links, images and HTML stay visible as text, so a summary can't send the
 * User elsewhere or load content while they decide. An operation with no summary renders as "".
 */
export function renderSummary(summary: string | undefined): string {
  if (summary === undefined) return "";
  return summary
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim());
      if (lines.every((line) => /^[-*+]\s+/.test(line)))
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^[-*+]\s+/, ""))}</li>`).join("")}</ul>`;
      if (lines.every((line) => /^\d{1,9}[.)]\s+/.test(line)))
        return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\d{1,9}[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      return `<p>${inline(lines.join(" "))}</p>`;
    })
    .join("");
}
