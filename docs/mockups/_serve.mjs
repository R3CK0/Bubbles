// Throwaway static server for reviewing the mockups in this folder.
// Run: node docs/mockups/_serve.mjs → http://127.0.0.1:4200/account-flows.html
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
http.createServer((req, res) => {
  const file = path.join(root, req.url === "/" ? "account-flows.html" : decodeURIComponent(req.url));
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(4200, "127.0.0.1", () => console.log("mockup server on :4200"));
