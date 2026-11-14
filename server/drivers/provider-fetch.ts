import { Agent, fetch } from "undici";

let longWaitAgent: Agent | undefined;

// Use the pinned transport even for short requests: Node's built-in fetch may predate GHSA-xjj6-f33q-929c.
export function providerFetch(url: string | URL, init: RequestInit, longWait = false): Promise<Response> {
  const dispatcher = longWait ? longWaitAgent ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 }) : undefined;
  return fetch(url, { ...init, dispatcher } as Parameters<typeof fetch>[1]) as unknown as Promise<Response>;
}
