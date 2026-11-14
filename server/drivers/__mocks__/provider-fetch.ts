export function providerFetch(url: string | URL, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}
