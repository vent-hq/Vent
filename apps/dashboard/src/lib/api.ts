const API_URL = "/backend";

export interface AccessToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
  active: boolean;
}

export interface CreateAccessTokenResponse {
  id: string;
  refresh_token: string;
  name: string;
  prefix: string;
  created_at: string;
}

export async function fetchAccessTokens(): Promise<AccessToken[]> {
  const res = await fetch(`${API_URL}/keys`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch access tokens: ${res.status}`);
  return res.json();
}

export async function createAccessToken(name: string): Promise<CreateAccessTokenResponse> {
  const res = await fetch(`${API_URL}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to create access token: ${res.status}`);
  return res.json();
}

export async function revokeAccessToken(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/keys/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to revoke access token: ${res.status}`);
}
