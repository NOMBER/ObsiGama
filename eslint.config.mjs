// Lints the plugin with Obsidian's official rules (the same family the community directory scanner uses).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules", "main.js", "esbuild.config.mjs", "vitest.config.mts", "scripts", "supabase",
    "examples", "test", "packages/sdk/test", "packages/sdk/README.md", "docs",
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
      },
    },
  },
]);
