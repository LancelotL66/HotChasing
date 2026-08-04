import { config } from './config.mjs';

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiSecret) headers.Authorization = `Bearer ${config.apiSecret}`;
  const response = await fetch(`${config.backendUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`API ${method} ${path} -> ${response.status}: ${data?.error || data || text}`);
  }
  return data;
}

export function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  return line;
}
