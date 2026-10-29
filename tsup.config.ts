import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: ["jsonc-parser"], // Bundle this to fix its broken ESM imports
    esbuildOptions(options) {
        // Keep non-ASCII text literal in dist so shipped notices and prompts can
        // be grepped and reviewed instead of decoded from \u escapes.
        options.charset = "utf8"
    },
})
