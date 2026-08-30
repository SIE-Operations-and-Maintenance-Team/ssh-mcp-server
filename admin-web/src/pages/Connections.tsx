import React, { useEffect, useState, useRef } from "react";
import { Table, Button, Modal, Form, Input, InputNumber, message, Popconfirm, Card, Space, Tag, Empty, Typography, Collapse, Switch, Select, Alert, Upload, List, Spin, theme } from "antd";
import { PlusOutlined, ReloadOutlined, ApiOutlined, SafetyCertificateOutlined, DownloadOutlined, UploadOutlined, InfoCircleOutlined, ProjectOutlined, AppstoreOutlined, EditOutlined, DeleteOutlined, StarOutlined, StarFilled } from "@ant-design/icons";
import { api } from "../api/client";

// Switch + 右侧说明文字的受控包装：作为 Form.Item 的单个子元素，保证 value/onChange 注入正常
function SwitchWithHint(props: { checked?: boolean; onChange?: (checked: boolean, event: any) => void; children?: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <Switch checked={props.checked} onChange={props.onChange} />
      <Typography.Text type="secondary" style={{ marginLeft: 8 }}>{props.children}</Typography.Text>
    </span>
  );
}

// 主机表格行拖拽（原生 HTML5 DnD），moveRow/dragKeyRef 由父级传入（ref 需跨行共享）
function DraggableRow({ moveRow, dragKeyRef, ...restProps }: any) {
  return (
    <tr
      {...restProps}
      draggable
      style={{ ...restProps.style, cursor: "grab" }}
      onDragStart={(e) => { dragKeyRef.current = restProps["data-row-key"] ?? null; e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={(e) => { e.preventDefault(); const from = dragKeyRef.current; dragKeyRef.current = null; const to = restProps["data-row-key"]; if (from && to) moveRow?.(from, to); }}
    />
  );
}

export default function Connections() {
  const { token } = theme.useToken();
  const [projects, setProjects] = useState<any[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<any>(null);
  const [activeEnv, setActiveEnv] = useState<string | null>(null);
  const [hosts, setHosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const [projectOpen, setProjectOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [projectForm] = Form.useForm();

  const [envOpen, setEnvOpen] = useState(false);
  const [editingEnv, setEditingEnv] = useState<string | null>(null);
  const [envForm] = Form.useForm();

  const [hostOpen, setHostOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [hostForm] = Form.useForm();

  const [importPlan, setImportPlan] = useState<any>(null);
  const [importPlanOpen, setImportPlanOpen] = useState(false);
  const [dragProjectIndex, setDragProjectIndex] = useState<number | null>(null);
  const dragHostKeyRef = useRef<string | null>(null);
  const [envOptions, setEnvOptions] = useState<string[]>([]);
  const [testingName, setTestingName] = useState<string | null>(null);
  // 交互 busy 状态：弹窗确认按钮 / 删除 / 导入导出 / 刷新
  const [projectSaving, setProjectSaving] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);
  const [hostSaving, setHostSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 按 hostOrder 数组返回排序后的主机列表（对象 key 对纯数字名会重排，不能依赖 key 顺序）
  const getOrderedHosts = (env: any): any[] => {
    const hostsMap = env?.hosts || {};
    const order = env?.hostOrder;
    if (!Array.isArray(order) || order.length === 0) return Object.values(hostsMap);
    const byName: Record<string, any> = hostsMap;
    const out: any[] = [];
    const seen = new Set<string>();
    for (const n of order) if (byName[n] && !seen.has(n)) { out.push(byName[n]); seen.add(n); }
    for (const [k, v] of Object.entries(byName)) if (!seen.has(k)) out.push(v);
    return out;
  };

  const loadProjects = async () => {
    setLoading(true);
    try {
      const idx = await api.projects.list();
      const list = Array.isArray(idx) ? idx : [];
      setProjects(list);
      if (list.length) {
        const first = list.find((p: any) => p.name === list[0].name) || list[0];
        const proj = list.find((p: any) => p.name === activeProject) || first;
        setActiveProject(proj.name);
        const detail = await api.projects.get(proj.name);
        setProjectDetail(detail);
        const envs = Object.keys(detail.environments || {});
        const targetEnv = detail.defaultEnvironment && detail.environments[detail.defaultEnvironment] ? detail.defaultEnvironment : envs[0] || null;
        setActiveEnv(targetEnv);
        setHosts(targetEnv ? getOrderedHosts(detail.environments[targetEnv]) : []);
      } else {
        setActiveProject(null);
        setProjectDetail(null);
        setActiveEnv(null);
        setHosts([]);
      }
    } catch (e: any) {
      message.error(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
    // 默认环境选项来自后端唯一来源（services/defaults.ts），避免前后端写死漂移
    api.defaults().then((d: any) => setEnvOptions(Array.isArray(d?.defaultEnvironments) ? d.defaultEnvironments : [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProject = async (name: string) => {
    setActiveProject(name);
    setDetailLoading(true);
    try {
      const detail = await api.projects.get(name);
      setProjectDetail(detail);
      const envs = Object.keys(detail.environments || {});
      const targetEnv = detail.defaultEnvironment && detail.environments[detail.defaultEnvironment] ? detail.defaultEnvironment : envs[0] || null;
      setActiveEnv(targetEnv);
      setHosts(targetEnv ? getOrderedHosts(detail.environments[targetEnv]) : []);
    } catch (e: any) {
      message.error(e?.message || "加载项目详情失败");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleEnvChange = (key: string) => {
    setActiveEnv(key);
    if (projectDetail?.environments?.[key]) {
      setHosts(getOrderedHosts(projectDetail.environments[key]));
    } else {
      setHosts([]);
    }
  };

  const refreshDetail = async (projName?: string, preferredEnv?: string | null) => {
    const targetProject = projName || activeProject;
    if (!targetProject) return;
    setDetailLoading(true);
    try {
      const detail = await api.projects.get(targetProject);
      setProjectDetail(detail);
      const envs = Object.keys(detail.environments || {});
      let targetEnv: string | null = null;
      if (preferredEnv && detail.environments[preferredEnv]) targetEnv = preferredEnv;
      else if (activeEnv && detail.environments[activeEnv]) targetEnv = activeEnv;
      else targetEnv = detail.defaultEnvironment && detail.environments[detail.defaultEnvironment] ? detail.defaultEnvironment : envs[0] || null;
      setActiveEnv(targetEnv);
      setHosts(targetEnv ? getOrderedHosts(detail.environments[targetEnv]) : []);
    } finally {
      setDetailLoading(false);
    }
  };

  // 项目操作
  const validateProjectName = (_: any, value: string) => {
    const name = (value || "").trim();
    if (!name) return Promise.resolve();
    const dup = projects.some((p: any) => p && p.name === name && p.name !== editingProject);
    return dup ? Promise.reject(new Error(`项目名称 "${name}" 已存在`)) : Promise.resolve();
  };

  const openCreateProject = () => {
    setEditingProject(null);
    projectForm.resetFields();
    setProjectOpen(true);
  };

  const openEditProject = (rec: any) => {
    setEditingProject(rec.name);
    projectForm.setFieldsValue({ name: rec.name, displayName: rec.displayName || "", defaultEnvironment: rec.defaultEnvironment || "" });
    setProjectOpen(true);
  };

  const saveProject = async () => {
    setProjectSaving(true);
    try {
      const v = await projectForm.validateFields();
      const payload: any = { name: String(v.name).trim(), displayName: v.displayName?.trim() || undefined, defaultEnvironment: v.defaultEnvironment?.trim() || undefined, originalName: editingProject || undefined };
      if (payload.defaultEnvironment === "") delete payload.defaultEnvironment;
      if (payload.displayName === "") delete payload.displayName;
      await api.projects.save(payload);
      message.success(editingProject ? "已重命名项目" : "已创建项目");
      setProjectOpen(false);
      projectForm.resetFields();
      const newName = payload.name;
      const wasEditing = editingProject;
      setEditingProject(null);
      // 重新加载索引并选中新项目
      setLoading(true);
      try {
        const idx = await api.projects.list();
        const list = Array.isArray(idx) ? idx : [];
        setProjects(list);
        const targetName = newName;
        setActiveProject(targetName);
        const detail = await api.projects.get(targetName);
        setProjectDetail(detail);
        const envs = Object.keys(detail.environments || {});
        const targetEnv = detail.defaultEnvironment && detail.environments[detail.defaultEnvironment] ? detail.defaultEnvironment : envs[0] || null;
        setActiveEnv(targetEnv);
        setHosts(targetEnv ? getOrderedHosts(detail.environments[targetEnv]) : []);
      } finally {
        setLoading(false);
      }
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || "保存项目失败");
    } finally {
      setProjectSaving(false);
    }
  };

  const deleteProject = async (name: string) => {
    setBusyKey(`project:${name}`);
    try {
      await api.projects.remove(name);
      message.success("已删除项目");
      // 若删除的是当前选中，重置后重载
      if (activeProject === name) {
        setActiveProject(null);
        setProjectDetail(null);
        setActiveEnv(null);
        setHosts([]);
      }
      await loadProjects();
    } catch (e: any) {
      message.error(e?.message || "删除失败");
    } finally {
      setBusyKey(null);
    }
  };

  // 项目拖拽排序（本地重排 + 后端持久化顺序）
  const reorderProjects = async (from: number, to: number) => {
    if (from === to) return;
    const arr = [...projects];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    setProjects(arr);
    try {
      await api.projects.reorder(arr.map((p: any) => p.name));
    } catch {
      message.error("排序保存失败");
      loadProjects();
    }
  };

  // 环境操作
  const openCreateEnv = () => {
    if (!activeProject) { message.warning("请先选择项目"); return; }
    setEditingEnv(null);
    envForm.resetFields();
    setEnvOpen(true);
  };

  const openEditEnv = (envName: string) => {
    setEditingEnv(envName);
    envForm.setFieldsValue({ name: envName });
    setEnvOpen(true);
  };

  const saveEnv = async () => {
    setEnvSaving(true);
    try {
      const v = await envForm.validateFields();
      const payload: any = { name: String(v.name).trim(), originalName: editingEnv || undefined };
      if (!activeProject) return;
      await api.environments.save(activeProject, payload);
      message.success(editingEnv ? "已重命名环境" : "已创建环境");
      setEnvOpen(false);
      envForm.resetFields();
      const newEnvName = payload.name;
      setEditingEnv(null);
      await refreshDetail(activeProject, newEnvName);
      try { const idx = await api.projects.list(); setProjects(Array.isArray(idx) ? idx : []); } catch {}
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || "保存环境失败");
    } finally {
      setEnvSaving(false);
    }
  };

  const deleteEnv = async (envName: string) => {
    if (!activeProject) return;
    setBusyKey(`env:${envName}`);
    try {
      await api.environments.remove(activeProject, envName);
      message.success("已删除环境");
      await refreshDetail(activeProject, null);
      try { const idx = await api.projects.list(); setProjects(Array.isArray(idx) ? idx : []); } catch {}
    } catch (e: any) {
      message.error(e?.message || "删除环境失败");
    } finally {
      setBusyKey(null);
    }
  };

  // 主机操作（复用现有 Modal+Form 25 字段分组）
  // 主机信息校验：名称唯一、地址(IP/别名)合法、端口范围
  const validateHostName = (_: any, value: string) => {
    const name = (value || "").trim();
    if (!name) return Promise.resolve();
    const dup = hosts.some((h: any) => h && h.name === name && h.name !== editingHost);
    return dup ? Promise.reject(new Error(`主机名称 "${name}" 已存在`)) : Promise.resolve();
  };

  const isValidIpv4 = (s: string) => {
    const parts = s.split(".");
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  };

  const isValidIpv6 = (s: string) => {
    if (s.indexOf("::") !== s.lastIndexOf("::")) return false; // `::` 只能出现一次
    if (!/^[0-9a-fA-F:]+$/.test(s) || /:{3,}/.test(s)) return false; // 仅允许 hex 与冒号，禁止连续 3+ 冒号
    const pieces = s.split("::");
    const groups = pieces.join(":").split(":").filter(Boolean);
    return groups.length <= 8 && groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
  };

  const validateHostAddress = (_: any, value: string) => {
    const v = (value || "").trim();
    if (!v) return Promise.resolve();
    if (v.includes(":")) {
      return isValidIpv6(v) ? Promise.resolve() : Promise.reject(new Error("IPv6 地址格式不正确"));
    }
    if (/^[\d.]+$/.test(v)) {
      return isValidIpv4(v) ? Promise.resolve() : Promise.reject(new Error("IP 地址格式不正确"));
    }
    // 主机名/SSH 别名：仅拦截明显非法字符（空格、路径分隔符）
    if (/[\s/\\]/.test(v)) return Promise.reject(new Error("主机名/别名不能包含空格或路径分隔符"));
    return Promise.resolve();
  };

  const validatePort = (_: any, value: any) => {
    if (value == null || value === "") return Promise.resolve();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return Promise.reject(new Error("端口须为 1-65535 的整数"));
    return Promise.resolve();
  };

  const openCreateHost = () => {
    if (!activeProject || !activeEnv) { message.warning(activeProject ? "请先创建环境" : "请先选择项目"); return; }
    setEditingHost(null);
    setHostOpen(true);
    setTimeout(() => {
      hostForm.resetFields();
      hostForm.setFieldsValue({ port: 22, pty: true, transportMode: "exec" });
    }, 0);
  };

  const openEditHost = (rec: any) => {
    setEditingHost(rec.name);
    setHostOpen(true);
    setTimeout(() => {
      const toText = (arr: any) => (Array.isArray(arr) ? arr.join("\n") : arr || "");
      const toComma = (arr: any) => (Array.isArray(arr) ? arr.join(", ") : arr || "");
      hostForm.setFieldsValue({
        ...rec,
        // 显式归一化 Switch 布尔值，确保勾选态正确回显
        tryKeyboard: !!rec.tryKeyboard,
        pty: rec.pty !== undefined ? !!rec.pty : true,
        commandWhitelist: toText(rec.commandWhitelist),
        commandBlacklist: toText(rec.commandBlacklist),
        allowedLocalPaths: toComma(rec.allowedLocalPaths),
        allowedRemotePaths: toComma(rec.allowedRemotePaths),
        algorithms: rec.algorithms ? JSON.stringify(rec.algorithms, null, 2) : undefined,
      });
    }, 0);
  };

  const saveHost = async () => {
    setHostSaving(true);
    try {
    await hostForm.validateFields();
    const v = hostForm.getFieldsValue(true);
    const toLines = (s: any): string[] | undefined => {
      if (s == null || s === "") return undefined;
      if (Array.isArray(s)) return s;
      const raw = String(s).split("\n").map((x: string) => x.trim()).filter(Boolean);
      if (!raw.length) return undefined;
      return raw.map((x: string) => (x.startsWith("^") ? x : "^" + x));
    };
    const toPaths = (s: any): string[] | undefined => {
      if (s == null || s === "") return undefined;
      if (Array.isArray(s)) return s;
      const arr = String(s).split(",").map((x: string) => x.trim()).filter(Boolean);
      return arr.length ? arr : undefined;
    };
    const payload: any = { ...v };
    if (payload.password === "***") delete payload.password;
    if (payload.passphrase === "***") delete payload.passphrase;
    for (const k of Object.keys(payload)) {
      if (payload[k] === "" || payload[k] == null) delete payload[k];
    }
    const wl = toLines(v.commandWhitelist);
    const bl = toLines(v.commandBlacklist);
    if (wl !== undefined) payload.commandWhitelist = wl; else delete payload.commandWhitelist;
    if (bl !== undefined) payload.commandBlacklist = bl; else delete payload.commandBlacklist;
    const lp = toPaths(v.allowedLocalPaths);
    const rp = toPaths(v.allowedRemotePaths);
    if (lp !== undefined) payload.allowedLocalPaths = lp; else delete payload.allowedLocalPaths;
    if (rp !== undefined) payload.allowedRemotePaths = rp; else delete payload.allowedRemotePaths;
    if (v.algorithms) {
      try {
        payload.algorithms = typeof v.algorithms === "string" ? JSON.parse(v.algorithms) : v.algorithms;
      } catch {
        message.error("算法配置 JSON 格式不正确");
        return;
      }
    }
    try {
      if (!activeProject || !activeEnv) { message.warning("请先选择项目与环境"); return; }
      await api.hosts.save(activeProject, activeEnv, { ...payload, originalName: editingHost || undefined });
      message.success("已保存");
      setHostOpen(false);
      hostForm.resetFields();
      setEditingHost(null);
      await refreshDetail(activeProject, activeEnv);
      try { const idx = await api.projects.list(); setProjects(Array.isArray(idx) ? idx : []); } catch {}
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    }
    } finally {
      setHostSaving(false);
    }
  };

  const deleteHost = async (rec: any) => {
    if (!activeProject || !activeEnv) return;
    setBusyKey(`host:${rec.name}`);
    try {
      await api.hosts.remove(activeProject, activeEnv, rec.name);
      message.success("已删除");
      await refreshDetail(activeProject, activeEnv);
      try { const idx = await api.projects.list(); setProjects(Array.isArray(idx) ? idx : []); } catch {}
    } catch (e: any) {
      message.error(e?.message || "删除失败");
    } finally {
      setBusyKey(null);
    }
  };

  // 主机拖拽排序（按 name 定位，不受分页 index 影响；本地重排 + 后端持久化）
  const moveHost = async (fromKey: string, toKey: string) => {
    if (!activeProject || !activeEnv || fromKey === toKey) return;
    const arr = [...hosts];
    const fromIdx = arr.findIndex((h: any) => h.name === fromKey);
    const toIdx = arr.findIndex((h: any) => h.name === toKey);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    setHosts(arr);
    try {
      await api.hosts.reorder(activeProject, activeEnv, arr.map((h: any) => h.name));
    } catch {
      message.error("排序保存失败");
      refreshDetail(activeProject, activeEnv);
    }
  };

  const test = async (rec: any) => {
    setTestingName(rec.name);
    try {
      const r: any = await api.test(rec);
      if (r.ok) message.success(`连接成功，延迟 ${r.latencyMs} 毫秒`);
      else message.error(`连接失败 [${r.code}]：${r.message}`);
    } catch (e: any) {
      message.error(e?.message || "测试连接失败");
    } finally {
      setTestingName(null);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const data: any = await (api as any).configExportRaw();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ssh-mcp-config.json";
      a.click();
      URL.revokeObjectURL(url);
      message.success("已导出配置");
    } catch (e: any) {
      message.error("导出失败：" + String(e?.message || e));
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res: any = await (api as any).configImport(parsed);
      if (res?.ok === false) throw new Error(res.message || "导入失败");
      setImportPlan(res);
      setImportPlanOpen(true);
      message.success(`已导入 ${res.addedHosts ?? res.count ?? 0} 个主机`);
      await loadProjects();
    } catch (e: any) {
      message.error("导入失败：" + String(e?.message || e));
    } finally {
      setImporting(false);
    }
  };

  const envLabelMap: Record<string, string> = {
    // 兼容旧英文 key
    dev: "开发环境",
    test: "测试环境",
    prod: "生产环境",
    uat: "UAT环境",
    other: "其他环境",
  };
  const envKeys = projectDetail ? Object.keys(projectDetail.environments || {}) : [];
  const envSelectOptions = envKeys.map((k) => ({
    value: k,
    label: projectDetail?.defaultEnvironment === k ? `${envLabelMap[k] || k}（默认）` : envLabelMap[k] || k,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
      <Alert closable type="info" showIcon icon={<InfoCircleOutlined />} message="复用 ~/.ssh/config" description="Host 可填别名（如 myserver），自动复用本地 SSH 配置；如需自定义路径可在设置中配置 ssh-config-file（后续支持）" style={{ borderRadius: 12, flexShrink: 0 }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, flexShrink: 0 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0, fontWeight: 700 }}>
            <ApiOutlined style={{ color: "#1677ff", marginRight: 8 }} />连接管理
          </Typography.Title>
          <Typography.Text type="secondary">按 项目 → 环境 → 主机 三级管理，支持两阶段加载与导入结果查看</Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadProjects}>刷新</Button>
          <Upload accept=".json" showUploadList={false} beforeUpload={(file) => { handleImportFile(file); return false; }}>
            <Button icon={<UploadOutlined />} loading={importing}>导入 JSON</Button>
          </Upload>
          <Button icon={<DownloadOutlined />} loading={exporting} onClick={handleExport}>导出 JSON</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateHost}>新增主机</Button>
        </Space>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flex: 1, minHeight: 0 }}>
        {/* 项目侧栏 */}
        <Card style={{ width: 280, flexShrink: 0, borderRadius: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.04)", height: "100%", display: "flex", flexDirection: "column" }} bodyStyle={{ padding: 12, flex: 1, overflow: "auto" }} title={<span><ProjectOutlined style={{ marginRight: 8 }} />项目</span>} extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateProject}>新建</Button>}>
          {loading ? <div style={{ textAlign: "center", padding: 24 }}><Spin /></div> : projects.length === 0 ? (
            <Empty description="暂无项目" image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreateProject}>创建项目</Button>
            </Empty>
          ) : (
            <List
              dataSource={projects}
              renderItem={(item: any, index: number) => {
                const isActive = item.name === activeProject;
                return (
                  <List.Item
                    onClick={() => selectProject(item.name)}
                    draggable
                    onDragStart={() => setDragProjectIndex(index)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragProjectIndex !== null) reorderProjects(dragProjectIndex, index); setDragProjectIndex(null); }}
                    style={{ cursor: "grab", background: isActive ? token.colorPrimaryBg : undefined, borderRadius: 8, padding: "8px 10px", marginBottom: 6, border: isActive ? `1px solid ${token.colorPrimaryBorder}` : "1px solid transparent" }}
                    actions={[
                      <Button key="edit" type="text" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); openEditProject(item); }} />,
                      <Popconfirm key="del" title="确认删除该项目吗？级联删除全部环境与主机" okText="确认" cancelText="取消" onConfirm={() => deleteProject(item.name)}>
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} loading={busyKey === `project:${item.name}`} onClick={(e) => e.stopPropagation()} />
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={<span style={{ fontWeight: isActive ? 700 : 400 }}>{item.displayName ? `${item.displayName} (${item.name})` : item.name}{item.defaultEnvironment ? <Tag color="gold" icon={<StarFilled />} style={{ marginLeft: 6, borderRadius: 10 }}>默认:{envLabelMap[item.defaultEnvironment] || item.defaultEnvironment}</Tag> : null}</span>}
                      description={<span style={{ fontSize: 12 }}>{item.environmentCount} 环境 · {item.hostCount} 主机</span>}
                    />
                  </List.Item>
                );
              }}
            />
          )}
        </Card>

        {/* 主内容：环境下拉 + 主机 Table */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16, height: "100%", overflow: "auto" }}>
          {!activeProject ? (
            <Card style={{ borderRadius: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
              <Empty description="暂无项目，请先创建项目" image={Empty.PRESENTED_IMAGE_SIMPLE}>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreateProject}>创建项目</Button>
              </Empty>
            </Card>
          ) : detailLoading ? (
            <Card style={{ borderRadius: 16 }}><div style={{ textAlign: "center", padding: 40 }}><Spin tip="加载项目详情..." /></div></Card>
          ) : envKeys.length === 0 ? (
            <Card style={{ borderRadius: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }} title={<span><AppstoreOutlined style={{ marginRight: 8 }} />环境</span>} extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateEnv}>新建环境</Button>}>
              <Empty description="该项目暂无环境" image={Empty.PRESENTED_IMAGE_SIMPLE}>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreateEnv}>创建环境</Button>
              </Empty>
            </Card>
          ) : (
            <Card style={{ borderRadius: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }} bodyStyle={{ paddingTop: 16 }} title={<span><AppstoreOutlined style={{ marginRight: 8 }} />环境</span>} extra={<Tag color="blue" icon={<SafetyCertificateOutlined />}>共 {hosts.length} 个主机</Tag>}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
                <Space>
                  <span style={{ fontWeight: 600 }}>当前环境：</span>
                  <Select
                    value={activeEnv}
                    onChange={handleEnvChange}
                    options={envSelectOptions}
                    placeholder="选择环境"
                    style={{ minWidth: 200 }}
                  />
                  {projectDetail?.defaultEnvironment && (
                    <Tag color="gold" icon={<StarFilled />} style={{ borderRadius: 10 }}>
                      默认:{envLabelMap[projectDetail.defaultEnvironment] || projectDetail.defaultEnvironment}
                    </Tag>
                  )}
                </Space>
                <Space>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateEnv}>新建环境</Button>
                  {activeEnv && (
                    <>
                      <Button size="small" icon={<EditOutlined />} onClick={() => openEditEnv(activeEnv)}>重命名</Button>
                      <Popconfirm title={`确认删除环境 ${envLabelMap[activeEnv] || activeEnv} 吗？`} okText="确认" cancelText="取消" onConfirm={() => deleteEnv(activeEnv)}>
                        <Button size="small" danger icon={<DeleteOutlined />} loading={busyKey === `env:${activeEnv}`}>删除</Button>
                      </Popconfirm>
                    </>
                  )}
                </Space>
              </div>
              {hosts.length === 0 ? (
                <Empty description="该环境暂无主机" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: "24px 0" }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreateHost}>新增主机</Button>
                </Empty>
              ) : (
                <Table
                  rowKey="name"
                  dataSource={hosts}
                  pagination={false}
                  components={{ body: { row: (props: any) => <DraggableRow {...props} moveRow={moveHost} dragKeyRef={dragHostKeyRef} /> } }}
                  locale={{ emptyText: <Empty description="暂无主机" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                  columns={[
                    { title: "主机名", dataIndex: "name", render: (v: string) => <Tag color="geekblue" style={{ borderRadius: 20, padding: "0 10px" }}>{v}</Tag> },
                    { title: "地址", dataIndex: "host", render: (v: string) => <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 13 }}>{v}</span> },
                    { title: "端口", dataIndex: "port", width: 90, align: "center" as const },
                    { title: "用户", dataIndex: "username" },
                    {
                      title: "操作",
                      width: 240,
                      render: (_: any, rec: any) => (
                        <Space>
                          <Button size="small" onClick={() => openEditHost(rec)}>编辑</Button>
                          <Button size="small" type="primary" ghost loading={testingName === rec.name} onClick={() => test(rec)}>测试连接</Button>
                          <Popconfirm title="确认删除该主机吗？" okText="确认" cancelText="取消" onConfirm={() => deleteHost(rec)}>
                            <Button size="small" danger loading={busyKey === `host:${rec.name}`}>删除</Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
            </Card>
          )}
        </div>
      </div>

      {/* 项目 Modal */}
      <Modal open={projectOpen} onOk={saveProject} confirmLoading={projectSaving} onCancel={() => { setProjectOpen(false); projectForm.resetFields(); setEditingProject(null); }} title={editingProject ? "重命名项目" : "新建项目"} okText="保存" cancelText="取消" destroyOnClose>
        <Form form={projectForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }, { validator: validateProjectName }]}>
            <Input placeholder="例如：my-project" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="可选，例如：我的项目" />
          </Form.Item>
          <Form.Item name="defaultEnvironment" label="默认环境" extra="留空则默认为测试环境">
            <Select
              placeholder="请选择默认环境"
              allowClear
              options={(() => {
                if (editingProject && projectDetail && projectDetail.environments) {
                  const keys = Object.keys(projectDetail.environments);
                  return keys.map((k) => ({ value: k, label: envLabelMap[k] || k }));
                }
                return envOptions.map((k) => ({ value: k, label: envLabelMap[k] || k }));
              })()}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 环境 Modal */}
      <Modal open={envOpen} onOk={saveEnv} confirmLoading={envSaving} onCancel={() => { setEnvOpen(false); envForm.resetFields(); setEditingEnv(null); }} title={editingEnv ? "重命名环境" : "新建环境"} okText="保存" cancelText="取消" destroyOnClose>
        <Form form={envForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="环境名称" rules={[{ required: true, message: "请输入环境名称" }]}>
            <Input placeholder="例如：prod" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 主机 Modal（复用现有 25 字段分组） */}
      <Modal open={hostOpen} onOk={saveHost} confirmLoading={hostSaving} onCancel={() => { setHostOpen(false); hostForm.resetFields(); setEditingHost(null); }} title={editingHost ? "编辑主机" : "主机配置"} okText="保存" cancelText="取消" destroyOnClose width={720} style={{ top: 24 }}>
        <Form form={hostForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="主机名称" rules={[{ required: true, message: "请输入主机名称" }, { validator: validateHostName }]}>
            <Input placeholder="例如：web-01" />
          </Form.Item>
          <Form.Item name="host" label="主机地址" rules={[{ required: true, message: "请输入主机地址" }, { validator: validateHostAddress }]}>
            <Input placeholder="例如：192.168.1.100 或 myserver（复用 ~/.ssh/config）" />
          </Form.Item>
          <Form.Item name="port" label="端口" initialValue={22} rules={[{ validator: validatePort }]}>
            <InputNumber min={1} max={65535} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input placeholder="例如：root" />
          </Form.Item>
          <Form.Item name="password" label="密码">
            <Input.Password placeholder="请输入密码或使用密钥" />
          </Form.Item>
          <Collapse accordion ghost style={{ marginTop: 8 }} defaultActiveKey={[]} items={[
            { key: "auth", label: "认证高级（私钥/Agent/2FA）", forceRender: true, children: (<>
              <Form.Item name="privateKey" label="私钥路径" extra="支持 ~/ 展开，例如 ~/.ssh/id_rsa" tooltip="留空则用密码/Agent"><Input placeholder="~/.ssh/id_rsa" /></Form.Item>
              <Form.Item name="passphrase" label="私钥口令"><Input.Password placeholder="若私钥带口令则填写" /></Form.Item>
              <Form.Item name="agent" label="SSH Agent Socket" extra="Windows 填 pageant，Linux/macOS 默认为 $SSH_AUTH_SOCK"><Input placeholder="pageant 或 /tmp/ssh-xxx/agent.123" /></Form.Item>
              <Form.Item name="tryKeyboard" label="2FA 键盘交互" valuePropName="checked"><SwitchWithHint>启用 tryKeyboard，OTP 由环境变量 SSH_MCP_2FA_CODE 提供</SwitchWithHint></Form.Item>
            </>) },
            { key: "proxy", label: "代理与传输（堡垒机/模板）", forceRender: true, children: (<>
              <Form.Item name="proxy" label="代理 URL" extra="支持 socks5:// http:// https://，例 socks5://user:pass@127.0.0.1:1080" rules={[{ validator: (_, v) => { if (!v) return Promise.resolve(); try { new URL(v); return Promise.resolve(); } catch { return Promise.reject("代理 URL 格式不正确"); } } }]}><Input placeholder="socks5://127.0.0.1:1080" /></Form.Item>
              <Form.Item name="socksProxy" label="旧版 SOCKS 代理（兼容）"><Input placeholder="socks://127.0.0.1:10808" /></Form.Item>
              <Form.Item name="transportMode" label="传输模式" initialValue="exec"><Select options={[{ value: "exec", label: "exec（直连，支持 upload/download）" }, { value: "shell", label: "shell（堡垒机，持久会话）" }]} /></Form.Item>
              <Form.Item name="shellReadyTimeoutMs" label="Shell 就绪超时 (ms)"><InputNumber min={1000} max={120000} style={{ width: "100%" }} placeholder="10000" /></Form.Item>
              <Form.Item name="shellCommandTimeoutMs" label="Shell 单命令超时 (ms)"><InputNumber min={1000} max={600000} style={{ width: "100%" }} placeholder="30000" /></Form.Item>
              <Form.Item name="commandTemplate" label="命令模板" extra="需包含 <command> 或 <quotedCommand>，例：su root -c <quotedCommand> / docker exec -i c sh -c <quotedCommand>" rules={[{ validator: (_, v) => { if (!v) return Promise.resolve(); if (v.includes("<command>") || v.includes("<quotedCommand>")) return Promise.resolve(); return Promise.reject("必须包含 <command> 或 <quotedCommand>"); } }]}><Input placeholder="su root -c <quotedCommand>" /></Form.Item>
              <Form.Item name="pty" label="分配伪终端" valuePropName="checked"><SwitchWithHint>默认开启，关闭可提升部分场景性能</SwitchWithHint></Form.Item>
            </>) },
            { key: "timeouts", label: "超时与限制", forceRender: true, children: (<>
              <Form.Item name="commandTimeoutMs" label="命令超时 exec (ms)"><InputNumber min={1000} style={{ width: "100%" }} placeholder="30000" /></Form.Item>
              <Form.Item name="connectionTimeoutMs" label="建连超时 (ms)"><InputNumber min={1000} style={{ width: "100%" }} placeholder="30000" /></Form.Item>
              <Form.Item name="sftpTimeoutMs" label="SFTP 超时 (ms)"><InputNumber min={1000} style={{ width: "100%" }} placeholder="300000" /></Form.Item>
              <Form.Item name="maxOutputBytes" label="单命令输出上限 (bytes)" extra="默认 10485760 (10MiB)，0 表示不限制"><InputNumber min={0} style={{ width: "100%" }} placeholder="10485760" /></Form.Item>
              <Form.Item name="keepaliveIntervalMs" label="Keepalive 间隔 (ms)"><InputNumber min={1000} style={{ width: "100%" }} placeholder="10000" /></Form.Item>
              <Form.Item name="keepaliveCountMax" label="Keepalive 最大未响应数"><InputNumber min={1} style={{ width: "100%" }} placeholder="3" /></Form.Item>
            </>) },
            { key: "perSec", label: "按连接安全覆盖（留空则跟随全局）", forceRender: true, children: (<>
              <Form.Item name="commandWhitelist" label="命令白名单（每行一条正则）" extra="无需手写 ^，系统自动锚定行首"><Input.TextArea rows={3} placeholder={"ls.*\ncat\\s+.*"} /></Form.Item>
              <Form.Item name="commandBlacklist" label="命令黑名单（每行一条正则）" extra="无需手写 ^，系统自动锚定行首"><Input.TextArea rows={3} placeholder={"rm\\s+.*\nshutdown.*"} /></Form.Item>
              <Form.Item name="allowedLocalPaths" label="允许本地路径（逗号分隔）"><Input placeholder="/tmp, /home/user" /></Form.Item>
              <Form.Item name="allowedRemotePaths" label="允许远端路径（逗号分隔，绝对 POSIX）" extra="仅接受绝对路径，例如 /home, /tmp"><Input placeholder="/home, /tmp" /></Form.Item>
              <Form.Item name="algorithms" label="SSH 算法（JSON，可选）" extra="例：{&quot;kex&quot;: [&quot;...&quot;]}，留空使用默认"><Input.TextArea rows={3} placeholder='{"kex":["curve25519-sha256"]}' /></Form.Item>
            </>) },
          ]} />
        </Form>
      </Modal>

      {/* ImportPlan 预览 */}
      <Modal open={importPlanOpen} onCancel={() => setImportPlanOpen(false)} footer={[<Button key="ok" type="primary" onClick={() => setImportPlanOpen(false)}>确定</Button>]} title="导入结果" destroyOnClose width={640}>
        {importPlan ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Space wrap>
              <Tag color="green">新增项目 {importPlan.addedProjects ?? 0}</Tag>
              <Tag color="blue">更新项目 {importPlan.updatedProjects ?? 0}</Tag>
              <Tag color="purple">新增环境 {importPlan.addedEnvironments ?? 0}</Tag>
              <Tag color="geekblue">新增主机 {importPlan.addedHosts ?? importPlan.count ?? 0}</Tag>
            </Space>
            {Array.isArray(importPlan.warnings) && importPlan.warnings.length > 0 ? (
              <Alert type="warning" showIcon message="警告" description={<ul style={{ margin: 0, paddingLeft: 20 }}>{importPlan.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>} />
            ) : <Alert type="success" showIcon message="导入完成，无警告" />}
          </div>
        ) : <Empty description="无导入数据" />}
      </Modal>
    </div>
  );
}
