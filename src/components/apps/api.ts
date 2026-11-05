// small fetch helper for the apps and env APIs: returns the JSON body, throws the API's error message
export const call = async <T = any>(
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<T> => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json as T
}

// what GET /api/env returns (see src/server/env.ts); kept separate so no server code reaches the browser
export type Namespace = {
  name: string
  ait: string
  shared: boolean
  keys: string[]
  usedBy: string[]
  updatedAt: string
}

export type AppEnv = {
  appId: string
  namespaces: string[]
  keys: string[]
  effectiveKeys: string[]
  missing: string[]
  denied: string[]
  applied: boolean
}
