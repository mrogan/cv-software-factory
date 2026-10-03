/**
 * Route templates. The app names a route as a template, such as `/products/:slug`, and a sense reports each finding
 * on the route that way, so that every product page is one route and not thirty. A sense only sees URLs, so the
 * template is worked out from the shapes of the URLs it has seen, by two rules:
 *
 * 1. A collection: the first segment of paths that have a second segment, when two or more different second
 *    segments have been seen under it, or the collection's own page `/<name>` has. The second segment becomes a
 *    parameter. It is named `:slug` under `products` (as the probes name it) and otherwise for the collection's
 *    singular, so `/departments/home` is `/departments/:department`.
 * 2. Files: a path whose last segment has an extension, in a folder that holds two or more such files, becomes
 *    `<folder>/:file`, so every drawing is one route.
 *
 * Anything else is its own template. The query is never part of one.
 */

/** Returns a function that maps a path of the app to its template, given every path seen. */
export function templater(paths: Iterable<string>): (path: string) => string {
  const seen = [...new Set([...paths].map(withoutQuery))];
  const known = new Set(seen);
  const under = new Map<string, Set<string>>();
  const files = new Map<string, Set<string>>();
  for (const path of seen) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 2)
      under.set(parts[0] as string, (under.get(parts[0] as string) ?? new Set()).add(parts[1] as string));
    const last = parts.at(-1);
    if (parts.length >= 1 && last && /\.[a-z0-9]+$/i.test(last)) {
      const folder = path.slice(0, path.length - last.length);
      files.set(folder, (files.get(folder) ?? new Set()).add(last));
    }
  }
  return (path) => {
    const clean = withoutQuery(path);
    const parts = clean.split('/').filter(Boolean);
    const last = parts.at(-1);
    if (last && /\.[a-z0-9]+$/i.test(last)) {
      const folder = clean.slice(0, clean.length - last.length);
      return (files.get(folder)?.size ?? 0) >= 2 ? `${folder}:file` : clean;
    }
    const [collection] = parts;
    if (parts.length === 2 && collection && ((under.get(collection)?.size ?? 0) >= 2 || known.has(`/${collection}`))) {
      return `/${collection}/:${parameterFor(collection)}`;
    }
    return clean;
  };
}

const parameterFor = (collection: string): string =>
  collection === 'products' ? 'slug' : collection.replace(/s$/, '');

const withoutQuery = (path: string): string => path.split(/[?#]/)[0] || '/';
