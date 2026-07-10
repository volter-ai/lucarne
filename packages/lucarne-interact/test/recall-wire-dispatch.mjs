// LS-13W dev — the WIRE sensor's GENERIC adapter-selection loop (Chrome-free): `dispatchWireAdapters`
// is the PURE selection loop `startWireSensor` runs against a captured response — exercised here
// directly against fake adapters (match-gated, concatenating, error-isolating), mirroring
// `capture.ts`'s `dispatchExtractors` proof for the screen sensor
// (test/recall-extractor-dispatch.mjs).
//
// LS-29 (generalize-records): this package bundles no site-specific wire adapter of its own anymore
// (X's operationName -> parser dispatch table moved downstream to a domain package) — the PARSE-half
// proof that used to live in this file (driving the real `xWireAdapter` against captured x GraphQL
// response fixtures) now lives in that domain package's own test suite. This file keeps only the
// GENERAL framework proof.
//
// Run with `node test/recall-wire-dispatch.mjs` (after `npm run build`).
import { dispatchWireAdapters } from "../dist/recall/wire.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── dispatchWireAdapters — the selection loop (match-gated, concatenating, error-isolating),
//    mirroring capture.ts's dispatchExtractors exactly (test/recall-extractor-dispatch.mjs) ──
{
  const onlyExample = { match: (u) => u.includes("example.test"), dispatch: () => [{ tag: "from-example" }] };
  const onlyOther = { match: (u) => u.includes("other.test"), dispatch: () => [{ tag: "from-other" }] };
  const out = dispatchWireAdapters("https://example.test/i/api/graphql/qid/Op", {}, [onlyExample, onlyOther]);
  check("dispatchWireAdapters: only the MATCHING adapter's records are included", out.length === 1 && out[0].tag === "from-example", JSON.stringify(out));

  const bothA = { match: () => true, dispatch: () => [{ tag: "a" }] };
  const bothB = { match: () => true, dispatch: () => [{ tag: "b" }] };
  const concatenated = dispatchWireAdapters("u", {}, [bothA, bothB]);
  check("dispatchWireAdapters: multiple matching adapters' records are CONCATENATED", concatenated.length === 2 && concatenated.map((r) => r.tag).sort().join(",") === "a,b");

  const throwing = { match: () => true, dispatch: () => { throw new Error("boom"); } };
  const survivor = { match: () => true, dispatch: () => [{ tag: "survivor" }] };
  const isolated = dispatchWireAdapters("u", {}, [throwing, survivor]);
  check("dispatchWireAdapters: a THROWING adapter never breaks capture or its siblings", isolated.length === 1 && isolated[0].tag === "survivor", JSON.stringify(isolated));

  const none = dispatchWireAdapters("https://nowhere.test/", {}, [onlyExample, onlyOther]);
  check("dispatchWireAdapters: no adapter matches -> empty array, no throw", Array.isArray(none) && none.length === 0);

  const empty = dispatchWireAdapters("https://example.test/i/api/graphql/qid/Op", {}, []);
  check("dispatchWireAdapters: an empty adapter list -> empty array", empty.length === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
