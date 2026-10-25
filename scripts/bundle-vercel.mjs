// Bundles the compiled Nest app (dist/) and its pure-JS dependencies into one ESM file for Vercel.
//
// Why: Nest 12 is ESM-only, but @nestjs/throttler is CommonJS and `require()`s it. Node allows that, Vercel's
// Node runtime does not (ERR_REQUIRE_ESM), so the app crashed at start-up there. esbuild resolves every
// require/import at build time, so no require() of an ES module is left at runtime.
//
// Prisma and pg stay external: they ship native/wasm assets that must be loaded from node_modules (Vercel
// traces and includes them). They are CommonJS, which ESM `import` handles fine.
import { build } from "esbuild";

await build({
  entryPoints: ["serverless/handler.mjs"],
  outfile: "bundle/handler.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: [
    "@prisma/*", "pg", "pg-native", "*.node",
    // Optional Nest peers that this app does not install; Nest only loads them inside try/catch when a feature needs them.
    "class-validator", "class-transformer", "@nestjs/microservices", "@nestjs/microservices/*",
    "@nestjs/websockets", "@nestjs/websockets/*", "@nestjs/platform-socket.io", "@nestjs/platform-ws", "@fastify/static", "@fastify/view", "cache-manager",
  ],
  logOverride: { "require-resolve-not-external": "silent" },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
