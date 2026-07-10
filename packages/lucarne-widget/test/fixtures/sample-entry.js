// LS-15 dev/01 fixture — a NEUTRAL sample bundle entrypoint (no app-specific knowledge whatsoever), used to
// prove the build helper (`src/build.ts`) end-to-end: it deliberately contains a literal `</script>` inside a
// string literal so the escaping the helper is responsible for is exercised for real, not just asserted to never
// matter. esbuild's minifier does not touch string CONTENTS, so this literal string survives into the bundled
// output verbatim — exactly the case that would otherwise terminate the wrapping `<script>` tag early.
export const marker = "contains a literal </script> tag inside a string";
console.log(marker);
