export type Lens = "runtime" | "declaration";

export interface View {
  path: string[];
  lens: Lens;
  selected: string | null;
}

const DEFAULT_LENS: Lens = "runtime";

export function parseHash(hash: string): View {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart = ""] = raw.split("?");
  const params = new URLSearchParams(queryPart);

  const lensParam = params.get("lens");
  return {
    path: pathPart.split("/").filter(Boolean),
    // An unknown lens falls back rather than throwing. A bad link should show
    // something, not a blank page.
    lens: lensParam === "declaration" ? "declaration" : DEFAULT_LENS,
    selected: params.get("sel"),
  };
}

export function toHash(view: View): string {
  const path = `#/${view.path.join("/")}`;
  const params = new URLSearchParams();
  if (view.lens !== DEFAULT_LENS) params.set("lens", view.lens);
  if (view.selected) params.set("sel", view.selected);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
