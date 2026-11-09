import { API_BASE, loadAccessToken, refreshAccessToken } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export async function authenticatedFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const token = await loadAccessToken() ?? apiKey;
  const send = (accessToken: string) => {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(url, { ...options, headers });
  };
  const response = await send(token);
  if (response.status !== 401) return response;
  const refreshed = await refreshAccessToken(token);
  if (!refreshed) return response;
  await response.body?.cancel();
  return send(refreshed);
}

export async function apiFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<Response> {
  const res = await authenticatedFetch(path, apiKey, options);

  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    throw new ApiError(res.status, body);
  }

  return res;
}
