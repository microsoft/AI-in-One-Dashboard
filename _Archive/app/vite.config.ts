import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { managedApps } from "@microsoft/managed-apps-vite-plugin";
import { viteSingleFile } from "vite-plugin-singlefile";

const SAMPLE_FILES = ["interactions", "users", "agents"];
const SAMPLE_ID = "virtual:embedded-sample";
// The single-file build is committed here so customers can download it from the repo.
const FILE_OUT_DIR = "download";
const FILE_NAME = "AI-in-One-App.html";

// In the single-file build there's no server to fetch public/sample from, so the sample CSVs
// are gzipped into the page. Other builds get null and fetch them as before.
function embeddedSample(embed: boolean): Plugin {
  return {
    name: "embedded-sample",
    resolveId: (id) => (id === SAMPLE_ID ? "\0" + SAMPLE_ID : undefined),
    load(id) {
      if (id !== "\0" + SAMPLE_ID) return;
      if (!embed) return "export default null;";
      const files = Object.fromEntries(
        SAMPLE_FILES.map((f) => [f, gzipSync(readFileSync(`public/sample/${f}.csv`), { level: 9 }).toString("base64")]),
      );
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

// Makes the single-file build self-contained: the favicon becomes a data URI and the page
// gets a descriptive file name.
function singleFileFinish(): Plugin {
  return {
    name: "single-file-finish",
    enforce: "post",
    generateBundle(_, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return;
      delete bundle["index.html"];
      const icon = `data:image/svg+xml;base64,${readFileSync("public/favicon.svg").toString("base64")}`;
      const source = String(page.source).replace(/href="[^"]*favicon\.svg"/, `href="${icon}"`);
      this.emitFile({ type: "asset", fileName: FILE_NAME, source });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const file = mode === "file";
  return {
    plugins: file
      ? [react(), embeddedSample(true), viteSingleFile({ removeViteModuleLoader: true }), singleFileFinish()]
      : [react(), embeddedSample(false), managedApps()],
    build: file ? { outDir: FILE_OUT_DIR, copyPublicDir: false } : undefined,
  };
});
