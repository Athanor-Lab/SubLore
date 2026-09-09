import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The stand-in the update check talks to, so a battery never reaches the real network.
 *
 * The same shape as the stub sidecar: the app is pointed at it by an environment variable set
 * before any worker starts, and what it answers is decided by a file a spec writes. One server for
 * the whole run, because the app's endpoint is fixed when it launches and cannot vary per test.
 *
 * The control file is `update-answer.json` in the run's own data home:
 *
 * - missing: 404, which is what a project with no releases answers and what Sublore reads as
 *   "nothing newer".
 * - `{"closed": true}`: the socket is destroyed, which is a real connection failure and not a
 *   status code dressed up as one.
 * - anything else: 200 with the file's own bytes.
 */
export function answerPath(dataHome) {
  return path.join(dataHome, "update-answer.json");
}

export async function startUpdateStandIn(dataHome) {
  const server = createServer((request, response) => {
    let body = null;
    try {
      body = readFileSync(answerPath(dataHome), "utf8");
    } catch {
      // No file is the default answer, and the one the app meets on a project with no releases.
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    if (parsed !== null && parsed.closed === true) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/releases/latest`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The value the app reads, so a spec can say what it is pointed at without guessing. */
export function endpoint() {
  const url = process.env.SUBLORE_UPDATE_ENDPOINT;
  if (typeof url !== "string" || url === "") {
    throw new Error("SUBLORE_UPDATE_ENDPOINT is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return url;
}
