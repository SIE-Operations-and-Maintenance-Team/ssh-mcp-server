import React, { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import { Layout, Menu, Typography, ConfigProvider, Select, Tag, Button, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  ApiOutlined,
  SafetyCertificateOutlined,
  AuditOutlined,
  CloudServerOutlined,
  SettingOutlined,
  SunOutlined,
  MoonOutlined,
  DesktopOutlined,
  GithubOutlined,
} from "@ant-design/icons";
import Connections from "./pages/Connections";
import Audit from "./pages/Audit";
import Backups from "./pages/Backups";
import Settings from "./pages/Settings";
import Security from "./pages/Security";

function SiderMenu() {
  const location = useLocation();
  const raw = location.pathname.replace(/^\//, "");
  const selectedKey = raw === "" ? "connections" : raw;
  return (
    <Menu
      mode="inline"
      selectedKeys={[selectedKey]}
      style={{ border: "none", background: "transparent" }}
      items={[
        { key: "connections", icon: <ApiOutlined />, label: <Link to="/connections">连接管理</Link> },
        { key: "security", icon: <SafetyCertificateOutlined />, label: <Link to="/security">安全策略</Link> },
        { key: "audit", icon: <AuditOutlined />, label: <Link to="/audit">审计日志</Link> },
        { key: "backups", icon: <CloudServerOutlined />, label: <Link to="/backups">备份恢复</Link> },
        { key: "settings", icon: <SettingOutlined />, label: <Link to="/settings">设置</Link> },
      ]}
    />
  );
}

type ThemeMode = "light" | "dark" | "system";
function useThemeMode(){
  const [mode, setMode] = useState<ThemeMode>(()=>{
    const v = localStorage.getItem("admin-theme") as ThemeMode | null;
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  });
  const [systemDark, setSystemDark] = useState(()=> typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : false);
  useEffect(()=>{
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent)=> setSystemDark(e.matches);
    m.addEventListener("change", handler);
    return ()=> m.removeEventListener("change", handler);
  },[]);
  useEffect(()=>{ localStorage.setItem("admin-theme", mode); },[mode]);
  const effective: "light"|"dark" = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  return { mode, setMode, effective };
}

export default function App() {
  const { mode, setMode, effective } = useThemeMode();
  const isDark = effective === "dark";
  const [version, setVersion] = useState<string>("");
  const [configPath, setConfigPath] = useState<string>("");
  useEffect(() => {
    fetch("/admin/api/system/info")
      .then((r) => r.json())
      .then((d) => {
        if (d?.version) setVersion(String(d.version));
        if (d?.configPath) setConfigPath(String(d.configPath));
      })
      .catch(() => {});
  }, []);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 12,
          colorBgLayout: isDark ? "#141414" : "#f0f2f5",
        },
        components: {
          Menu: { itemBorderRadius: 10, itemMarginBlock: 4 },
          Card: { paddingLG: 20 },
          Table: { headerBg: isDark ? "#1f1f1f" : "#f7f9fc" },
        },
      }}
    >
    <HashRouter>
      <Layout style={{ minHeight: "100vh", background: isDark ? "#141414" : "#f0f2f5", overflow: "hidden" }}>
        <Layout.Header
          style={{
            height: 64,
            padding: "0 24px",
            background: "linear-gradient(135deg, #1677ff 0%, #4096ff 50%, #69b1ff 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            position: "sticky",
            top: 0,
            zIndex: 10,
            boxShadow: "0 2px 8px rgba(22,119,255,0.25)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Typography.Text style={{ color: "#fff", fontSize: 18, fontWeight: 700, letterSpacing: 0.5 }}>SSH 管理控制台</Typography.Text>
            {configPath && (
              <Tag style={{ margin: 0, borderRadius: 20, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.35)", color: "#fff", fontSize: 12, lineHeight: "20px", padding: "0 10px" }} title={configPath}>
                配置文件: {configPath}
              </Tag>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            {version && (
              <Tag style={{ margin: 0, borderRadius: 20, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.35)", color: "#fff", fontSize: 12, lineHeight: "20px", padding: "0 10px" }}>
                v{version}
              </Tag>
            )}
            <Select
              value={mode}
              onChange={(v)=> setMode(v as ThemeMode)}
              size="small"
              style={{ minWidth:130 }}
              options={[
                { value:"light", label: <span><SunOutlined style={{ marginRight:6 }}/>明亮</span> },
                { value:"dark", label: <span><MoonOutlined style={{ marginRight:6 }}/>暗黑</span> },
                { value:"system", label: <span><DesktopOutlined style={{ marginRight:6 }}/>跟随系统</span> },
              ]}
            />
            <Button
              type="text"
              href="https://github.com/SIE-Operations-and-Maintenance-Team/ssh-mcp-server"
              target="_blank"
              rel="noreferrer"
              title="GitHub 仓库"
              icon={<GithubOutlined style={{ color: "#fff", fontSize: 18 }} />}
            />
          </div>
        </Layout.Header>
        <Layout style={{ background: "transparent", padding: 16, gap: 16, height: "calc(100vh - 64px)", overflow: "hidden" }}>
          <Layout.Sider
            width={220}
            style={{
              background: isDark ? "#1f1f1f" : "#fff",
              borderRadius: 16,
              boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
              overflow: "hidden",
              padding: "16px 12px",
              height: "fit-content",
              position: "sticky",
              top: 80,
            }}
            breakpoint="lg"
            collapsedWidth={0}
          >
            <SiderMenu />
          </Layout.Sider>
          <Layout.Content
            style={{
              background: isDark ? "#1f1f1f" : "#fff",
              borderRadius: 16,
              boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
              padding: 24,
              minHeight: 560,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Routes>
              <Route path="/" element={<Navigate to="/connections" replace />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/security" element={<Security />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/backups" element={<Backups />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </Layout.Content>
        </Layout>
      </Layout>
    </HashRouter>
    </ConfigProvider>
  );
}
