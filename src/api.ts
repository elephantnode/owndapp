import type { PlatformCapabilities } from '../shared/types';
let token = '';
export async function connect() {
  const data = await request<{ token: string; version: string; home: string; capabilities?: PlatformCapabilities }>('/session', undefined, true);
  token = data.token;
  return data;
}
export async function request<T>(path: string, body?: unknown, session = false, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: { 'X-Owndapp-Client': 'web', ...(!session ? { 'X-Owndapp-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'ローカルAPIに接続できません。サーバーの状態を確認してください');
  return data as T;
}
