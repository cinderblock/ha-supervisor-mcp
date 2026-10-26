// Minimal Supervisor API client, authenticated with the add-on's own
// SUPERVISOR_TOKEN (role set by `hassio_role` in config.yaml).

export interface SupervisorResponse {
  status: number;
  body: unknown;
}

export async function supervisor(method: string, path: string, body?: unknown): Promise<SupervisorResponse> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error('SUPERVISOR_TOKEN is not set (not running as a Home Assistant add-on?)');
  if (!path.startsWith('/')) throw new Error(`Supervisor path must start with "/": ${path}`);
  const base = process.env.SUPERVISOR_URL ?? 'http://supervisor';
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') && text ? JSON.parse(text) : text };
}
