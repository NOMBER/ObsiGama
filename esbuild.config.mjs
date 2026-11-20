import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const memStore = `var __ogMemLocal=(function(){var m=Object.create(null);return{get length(){return Object.keys(m).length},clear:function(){m=Object.create(null)},getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},key:function(i){return Object.keys(m)[i]||null},removeItem:function(k){delete m[k]},setItem:function(k,v){m[k]=String(v)}}})();var __ogMemSession=(function(){var m=Object.create(null);return{get length(){return Object.keys(m).length},clear:function(){m=Object.create(null)},getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},key:function(i){return Object.keys(m)[i]||null},removeItem:function(k){delete m[k]},setItem:function(k,v){m[k]=String(v)}}})();`;

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron",
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language",
    "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
    ...builtinModules, ...builtinModules.map((m) => `node:${m}`),
  ],
  alias: { "@obsigama/sdk": "./packages/sdk/src/index.ts" },
  // supabase-js: use the browser build, never Node built-ins (the plugin must run on mobile)
  mainFields: ["browser", "module", "main"],
  conditions: ["browser"],
  platform: "browser",
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
  loader: { ".webp": "dataurl" },
  inject: ["./src/shim-fetch.ts"],
  banner: { js: memStore },
  define: {
    "globalThis.localStorage": "__ogMemLocal",
    "globalThis.sessionStorage": "__ogMemSession",
    "global.localStorage": "__ogMemLocal",
    "global.sessionStorage": "__ogMemSession",
    "window.localStorage": "__ogMemLocal",
    "window.sessionStorage": "__ogMemSession",
  },
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
