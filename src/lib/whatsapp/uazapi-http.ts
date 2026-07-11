interface UazapiErrorResponse {
  error?: string
}

/** Joins a user-supplied UAZAPI server URL with an API path, tolerating a trailing slash. */
export function uazapiUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${path}`
}

/** UAZAPI error bodies are a flat `{ error: string }` — unlike Meta's nested `{ error: { message } }`. */
export async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    if (data.error) message = data.error
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}
