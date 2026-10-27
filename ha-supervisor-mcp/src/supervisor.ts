// Minimal Supervisor API client, authenticated with the add-on's own
// SUPERVISOR_TOKEN (role set by `hassio_role` in config.yaml).

export interface SupervisorResponse {
  status: number;
  body: unknown;
}

export async function supervisor(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<SupervisorResponse> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error('SUPERVISOR_TOKEN is not set (not running as a Home Assistant add-on?)');
  if (!path.startsWith('/')) throw new Error(`Supervisor path must start with "/": ${path}`);
  const base = process.env.SUPERVISOR_URL ?? 'http://supervisor';
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') && text ? JSON.parse(text) : text };
}

/** Call a JSON endpoint and return its `data`, throwing on any non-ok answer. */
export async function supervisorData<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await supervisor(method, path, body);
  const json = res.body as { result?: string; data?: T; message?: string };
  if (res.status !== 200 || json?.result !== 'ok') {
    throw new Error(`Supervisor ${method} ${path} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return json.data as T;
}

/** The last `lines` journal lines of an add-on, as text. */
export async function addonLogs(slug: string, lines: number): Promise<string> {
  // `entries=:-N:` starts N entries before the newest one, so it returns N+1
  // (checked against Supervisor 2026.10); trim to the newest N.
  const res = await supervisor('GET', `/addons/${slug}/logs`, undefined, {
    Accept: 'text/plain',
    Range: `entries=:-${lines}:`,
  });
  if (res.status !== 200) throw new Error(`Supervisor GET /addons/${slug}/logs failed: ${res.status} ${res.body}`);
  const all = String(res.body).replace(/\n$/, '').split('\n');
  return all.slice(-lines).join('\n') + '\n';
}
