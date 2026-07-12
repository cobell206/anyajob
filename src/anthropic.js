// src/anthropic.js
// Lazy Anthropic client. The SDK is a heavy dependency that only the AI code
// paths (scoring, résumé/cover feedback, summaries, discovery, smartfetch)
// need — but src/server.js statically wires up every route, so a plain web
// request would otherwise parse the whole SDK at cold start just to serve the
// listings table. A dynamic import() defers that parse until the first real
// AI call; both the imported module and the constructed client are cached for
// the life of the (warm) Lambda, so subsequent calls pay nothing.
//
// Usage: `const client = await getAnthropic();` then `client.messages.create(…)`.

let clientPromise = null;

export function getAnthropic() {
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk').then(
      (m) => new m.default({ apiKey: process.env.ANTHROPIC_API_KEY }),
    );
  }
  return clientPromise;
}
