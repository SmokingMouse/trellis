import type {
  GwAdminUser,
  GwInvite,
  GwInviteCreateResponse,
  GwMe,
  GwShareCreateBody,
  GwSharesResponse,
  GwSubscribeResponse,
} from "./gw-types";

class GwApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GwApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GwApiError(0, `网关连接失败 (${msg})`);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response
  }

  if (!res.ok) {
    const errorMsg =
      (typeof data?.error === "string" ? data.error : null) ||
      `请求失败 (HTTP ${res.status})`;
    throw new GwApiError(res.status, errorMsg);
  }

  return data as unknown as T;
}

export async function fetchGwMe(): Promise<GwMe | null> {
  try {
    return await request<GwMe>("/__gw/api/me");
  } catch {
    return null;
  }
}

export async function fetchAdminUsers(): Promise<GwAdminUser[]> {
  return request<GwAdminUser[]>("/__gw/api/admin/users");
}

export async function disableAdminUser(name: string): Promise<void> {
  return request<void>(`/__gw/api/admin/users/${encodeURIComponent(name)}/disable`, {
    method: "POST",
  });
}

export async function enableAdminUser(name: string): Promise<void> {
  return request<void>(`/__gw/api/admin/users/${encodeURIComponent(name)}/enable`, {
    method: "POST",
  });
}

export async function restartAdminUser(name: string): Promise<void> {
  return request<void>(`/__gw/api/admin/users/${encodeURIComponent(name)}/restart`, {
    method: "POST",
  });
}

export async function fetchAdminInvites(): Promise<GwInvite[]> {
  return request<GwInvite[]>("/__gw/api/admin/invites");
}

export async function createAdminInvite(): Promise<GwInviteCreateResponse> {
  return request<GwInviteCreateResponse>("/__gw/api/admin/invites", {
    method: "POST",
  });
}

export async function deleteAdminInvite(code: string): Promise<void> {
  return request<void>(`/__gw/api/admin/invites/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
}

export async function fetchShares(): Promise<GwSharesResponse> {
  return request<GwSharesResponse>("/__gw/api/shares");
}

export async function createShare(body: GwShareCreateBody): Promise<{ id: string }> {
  return request<{ id: string }>("/__gw/api/shares", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteShare(id: string): Promise<void> {
  return request<void>(`/__gw/api/shares/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function subscribeShare(id: string): Promise<GwSubscribeResponse> {
  return request<GwSubscribeResponse>(
    `/__gw/api/shares/${encodeURIComponent(id)}/subscribe`,
    {
      method: "POST",
    },
  );
}

export async function unsubscribeShare(id: string): Promise<GwSubscribeResponse> {
  return request<GwSubscribeResponse>(
    `/__gw/api/shares/${encodeURIComponent(id)}/subscribe`,
    {
      method: "DELETE",
    },
  );
}
