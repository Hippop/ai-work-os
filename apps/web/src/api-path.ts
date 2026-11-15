/** Preserve legacy V1 call sites while routing explicitly versioned APIs verbatim. */
export function apiPath(path: string): string {
  return /^\/v[123]\//.test(path) ? `/api${path}` : `/api/v1${path}`;
}
