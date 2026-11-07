import { API_BASE } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export async function apiFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new ApiError(res.status, body);
  }

  return res;
}
