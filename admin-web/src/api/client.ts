async function handleResponse(r: Response) {
  const text = await r.text();
  let data: any = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!r.ok) {
    const msg = data?.message || data?.error || `请求失败 (${r.status})`;
    const err: any = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  projects: {
    list: (): Promise<any> => fetch("/admin/api/projects").then(handleResponse),
    get: (p: string): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(p)}`).then(handleResponse),
    save: (data: any): Promise<any> => fetch("/admin/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(handleResponse),
    remove: (p: string): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(p)}`, { method: "DELETE" }).then(handleResponse),
    reorder: (order: string[]): Promise<any> => fetch("/admin/api/projects/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order }) }).then(handleResponse),
  },
  environments: {
    save: (project: string, data: any): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(project)}/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(handleResponse),
    remove: (project: string, env: string): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}`, { method: "DELETE" }).then(handleResponse),
    get: (project: string, env: string): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}`).then(handleResponse),
  },
  hosts: {
    save: (project: string, env: string, data: any): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}/hosts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(handleResponse),
    remove: (project: string, env: string, host: string): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}/hosts/${encodeURIComponent(host)}`, { method: "DELETE" }).then(handleResponse),
    reorder: (project: string, env: string, order: string[]): Promise<any> => fetch(`/admin/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}/hosts/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order }) }).then(handleResponse),
  },
  list: (): Promise<any> => fetch("/admin/api/connections").then(handleResponse),
  save: (c: any) => fetch("/admin/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(handleResponse),
  remove: (name: string) => fetch(`/admin/api/connections/${encodeURIComponent(name)}`, { method: "DELETE" }).then(handleResponse),
  test: (c: any) => fetch("/admin/api/test-connection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(handleResponse),
  audit: (q: any = {}) => { const sp = new URLSearchParams(q as any).toString(); return fetch(`/admin/api/audit?${sp}`).then(handleResponse); },
  backups: () => fetch("/admin/api/backups").then(handleResponse),
  snapshot: () => fetch("/admin/api/backups/snapshot", { method: "POST" }).then(handleResponse),
  restore: (id: string) => fetch(`/admin/api/backups/restore/${encodeURIComponent(id)}`, { method: "POST" }).then(handleResponse),
  systemInfo: () => fetch("/admin/api/system/info").then(handleResponse),
  defaults: (): Promise<any> => fetch("/admin/api/defaults").then(handleResponse),
  registerMcp: (body: any) => fetch("/admin/api/system/register-mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(handleResponse),
  autostartGet: (): Promise<any> => fetch("/admin/api/autostart").then(handleResponse),
  autostartSave: (enabled: boolean): Promise<any> => fetch("/admin/api/autostart", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }).then(handleResponse),
  updateStatus: (): Promise<any> => fetch("/admin/api/update/status").then(handleResponse),
  updateCheck: (): Promise<any> => fetch("/admin/api/update/check", { method: "POST" }).then(handleResponse),
  updateApply: (): Promise<any> => fetch("/admin/api/update/apply", { method: "POST" }).then(handleResponse),
  restart: (): Promise<any> => fetch("/admin/api/restart", { method: "POST" }).then(handleResponse),
  securityGet: (): Promise<any> => fetch("/admin/api/security").then(handleResponse),
  securitySave: (body: any) => fetch("/admin/api/security", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(handleResponse),
  settingsGet: (): Promise<any> => fetch("/admin/api/settings").then(handleResponse),
  settingsSave: (body: any) => fetch("/admin/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(handleResponse),
  configExportRaw: (): Promise<any> => fetch("/admin/api/config/export").then(handleResponse),
  configImport: (data: any) => fetch("/admin/api/config/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(handleResponse)
};
