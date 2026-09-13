export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;

export async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`);
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  return JSON.parse(text);
}

export async function apiPost(path) {
  const r = await fetch(`${API_BASE}${path}`, { method: "POST" });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  return JSON.parse(text);
}
