// The general capture-corpus store — 5 modules, domain-agnostic. LS-29 moved the social schema +
// site-specific parsers (unit-to-record.ts, sites/x-aria.ts, sites/x-graphql.ts) downstream, to a
// domain package that builds its own projection on top of what's exported here.
export * from "./schema.js";
export * from "./cursor.js";
export * from "./validate.js";
export * from "./store.js";
export * from "./query.js";
