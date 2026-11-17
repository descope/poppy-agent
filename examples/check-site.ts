/**
 * Checks one Company's discovery chain against the spec and prints a report.
 *
 *   node examples/check-site.ts example.com
 *
 * Read-only: it GETs public metadata documents and nothing else, so it is safe to point at a
 * production domain. Exits non-zero when a MUST fails, which is what a CI step wants.
 */
import { checkSite, formatSiteReport } from "../src/conformance/index.ts";

const site = process.argv[2];
if (site === undefined) throw new Error("usage: node examples/check-site.ts <domain>");

const results = await checkSite(site);
console.log(formatSiteReport(site, results));

const failedMust = results.filter((result) => !result.ok && result.level === "MUST");
process.exitCode = failedMust.length > 0 ? 1 : 0;
