import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/assets/" : "/",
  plugins: [
    react(),
    // 开发模式下由 main.tsx 载入共享样式，移除生产环境的静态 CSS 标签。
    {
      name: "dev-html-rewrite",
      apply: "serve",
      transformIndexHtml(html: string) {
        return html
          .replace('/assets/app.js?token=__JUPITER_TOKEN__', '/src/main.tsx')
          .replace('/assets/icon.png?token=__JUPITER_TOKEN__', `/@fs/${resolve(__dirname, "../desktop/src-tauri/icons/icon.png")}`)
          .replace(
            '<link rel="stylesheet" href="/assets/app.css?token=__JUPITER_TOKEN__" />',
            "",
          );
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify("1.0.9"),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@jupiter/core-utils/compaction": resolve(__dirname, "../packages/core-utils/src/compaction.ts"),
      "@jupiter/core-utils/derive-prefix": resolve(__dirname, "../packages/core-utils/src/derive-prefix.ts"),
      "@jupiter/core-utils": resolve(__dirname, "../packages/core-utils/src/index.ts"),
      "@tauri-apps/api/core": resolve(__dirname, "src/lib/tauri-bridge.ts"),
      "@tauri-apps/api/event": resolve(__dirname, "src/lib/tauri-bridge.ts"),
      "@tauri-apps/api/window": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/api/webview": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/api/dpi": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/api/menu": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/plugin-dialog": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/plugin-notification": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/plugin-opener": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/plugin-process": resolve(__dirname, "src/lib/shell-services.ts"),
      "@tauri-apps/plugin-updater": resolve(__dirname, "src/lib/shell-services.ts"),
    },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, "src/main.tsx")
      },
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "app.css" || assetInfo.name === "index.css") return "app.css";
          // The server mounts this entire output directory at /assets/.
          return "[name].[ext]";
        },
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/katex/")) return "vendor-katex";
          if (
            id.includes("/react-markdown/") ||
            id.includes("/remark-") ||
            id.includes("/rehype-") ||
            id.includes("/mdast-") ||
            id.includes("/micromark") ||
            id.includes("/unist-") ||
            id.includes("/hast-")
          )
            return "vendor-markdown";
          if (id.includes("/prism-react-renderer/")) return "vendor-prism";
          if (id.includes("/lucide-react/")) return "vendor-icons";
          if (id.includes("/react-virtuoso/")) return "vendor-virtuoso";
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/"))
            return "vendor-react";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  }
}));
