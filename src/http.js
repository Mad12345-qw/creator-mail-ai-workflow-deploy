export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

export function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}

export function sendRedirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

export function getPathAndQuery(req) {
  const url = new URL(req.url, "http://localhost");
  return { path: url.pathname, query: url.searchParams };
}
