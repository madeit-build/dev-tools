export class MissingJson extends Error {
  constructor(readonly url: string) {
    super(`${url} is missing`);
    this.name = "MissingJson";
  }
}

// Vite answers any path it cannot find with the app's own index.html and a
// 200, so without this check a missing file surfaces as a JSON parse error
// about "<!doctype" instead of as missing.
export async function readJson(response: Response, url: string): Promise<unknown> {
  if (response.status === 404) throw new MissingJson(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/html")) throw new MissingJson(url);
  return response.json();
}
