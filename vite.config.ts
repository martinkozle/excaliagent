import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Excalidraw loads fonts from a CDN unless EXCALIDRAW_ASSET_PATH points at a
// local copy. We ship all fonts except Xiaolai (CJK, ~13 MB) so the board works
// offline for Latin text while keeping the npm package light; Xiaolai falls back
// to Excalidraw's default CDN.
const fontsDir = join(import.meta.dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");

function excalidrawFonts(): Plugin {
  let outDir = "";
  return {
    name: "excaliagent-fonts",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/fonts", (req, res, next) => {
        const file = normalize(join(fontsDir, decodeURIComponent((req.url ?? "/").split("?")[0]!)));
        if (!file.startsWith(fontsDir + sep) || file.includes("Xiaolai") || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("content-type", "font/woff2");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(fontsDir, join(outDir, "fonts"), {
        recursive: true,
        filter: (src) => !src.includes("Xiaolai"),
      });
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), excalidrawFonts()],
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
