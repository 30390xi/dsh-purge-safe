export function sendJson(response, status, payload, onFlushed) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload), () => {
    if (typeof onFlushed === "function") onFlushed();
  });
}
