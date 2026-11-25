/**
 * Serves a browser harness (a .tsx entry under tests/fixtures/) for an e2e spec, without the Next app
 * (that needs a database and Clerk). The entry is compiled by Vite through vitest's own API
 * (`createViteServer` from "vitest/node"): vitest is a direct dev dependency, so nothing here relies on a
 * package that is only installed as a dependency of another one.
 */
import { join } from "node:path";
import { createViteServer } from "vitest/node";

const ROOT = join(__dirname, "..", "..", "..");

export type Harness = { url: string; close: () => Promise<void> };

export async function startHarness(entry: string, css: string[]): Promise<Harness> {
  const page = `<!doctype html><html><head><meta charset="utf-8">${css.map((c) => `<link rel="stylesheet" href="/${c}">`).join("")}</head>`
    + `<body><div class="sas-app"><div id="root"></div></div><script type="module" src="/${entry}"></script></body></html>`;
  const server = await createViteServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    appType: "custom",
    resolve: { alias: { "@": `${ROOT}/` } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    optimizeDeps: { entries: [entry], include: ["react", "react/jsx-dev-runtime", "react/jsx-runtime", "react-dom", "react-dom/client"] },
    server: { port: 0, host: "127.0.0.1", hmr: false, watch: null },
    plugins: [{
      name: "harness-page",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url !== "/" && req.url !== "/index.html") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(page);
        });
      },
    }],
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("The harness server has no address.");
  return { url, close: () => server.close() };
}
