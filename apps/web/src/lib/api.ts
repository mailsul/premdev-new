export class ApiError extends Error {
  status: number;
  body: any;
  requestId?: string;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type ApiOptions = RequestInit & {
  timeoutMs?: number;
  silent?: boolean;
};

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function api<T = any>(
  path: string,
  opts: ApiOptions = {}
): Promise<T> {
  // Only set application/json when there's actually a body. Fastify rejects
  // requests that declare a JSON content-type but send an empty body with 400,
  // which broke buttons like Run/Stop/Restart that POST without a body.
  const hasBody = opts.body !== undefined && opts.body !== null;
  const headers: Record<string, string> = { ...(opts.headers as any || {}) };
  const id = requestId();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const silent = opts.silent === true;
  const requestOpts = { ...opts };
  delete requestOpts.timeoutMs;
  delete requestOpts.silent;
  if (hasBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  headers["X-Request-ID"] = id;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const abortExternal = () => controller.abort();
  opts.signal?.addEventListener("abort", abortExternal, { once: true });
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...requestOpts,
      headers,
      credentials: "include",
      signal: controller.signal,
    });
  } catch (cause: any) {
    const error = new ApiError(
      0,
      cause?.name === "AbortError" ? "Request timeout. Please try again." : (cause?.message ?? "Network request failed"),
    );
    error.requestId = id;
    if (!silent) emitApiError(error);
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortExternal);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText;
    const error = new ApiError(res.status, msg, body);
    error.requestId = id;
    if (!silent) emitApiError(error);
    throw error;
  }
  return body as T;
}

export const API = {
  get: <T = any>(p: string, opts?: ApiOptions) => api<T>(p, opts),
  post: <T = any>(p: string, data?: any) =>
    api<T>(p, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T = any>(p: string, data?: any) =>
    api<T>(p, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  patch: <T = any>(p: string, data?: any) =>
    api<T>(p, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  delete: <T = any>(p: string) => api<T>(p, { method: "DELETE" }),
};

function emitApiError(error: ApiError) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("premdev:toast", {
      detail: { kind: "error", message: error.message, requestId: error.requestId },
    }));
  }
}
