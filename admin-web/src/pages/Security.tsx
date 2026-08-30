import React, { useEffect, useState } from "react";
import { Form, Input, Alert, Card, Typography, Button, Space, Tag, message, theme } from "antd";
import { SafetyCertificateOutlined, ReloadOutlined, WarningOutlined, SaveOutlined } from "@ant-design/icons";
import { api } from "../api/client";

const stripCaret = (s:string)=> s.startsWith("^") ? s.slice(1) : s;

export default function Security(){
  const { token } = theme.useToken();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 默认黑名单来自后端唯一来源（GET /admin/api/defaults），前端不再写死
  const [defaultBlacklist, setDefaultBlacklist] = useState("");
  const blacklistValue = Form.useWatch("blacklist", form) as string | undefined;
  const previewList = ((blacklistValue ?? defaultBlacklist).split("\n").map(s=>s.trim()).filter(Boolean));
  const validateRegex=(_:any,v:string)=>{
    if(!v) return Promise.resolve();
    try{
      const lines=v.split("\n").filter(Boolean);
      for(const l of lines){
        const t=l.trim();
        const pattern=t.startsWith("^") ? t : "^"+t;
        new RegExp(pattern);
      }
      return Promise.resolve();
    } catch{ return Promise.reject("正则表达式格式不正确"); }
  };
  useEffect(()=>{ loadSecurity(); },[]);
  const loadSecurity = () => {
    setLoading(true);
    api.defaults().then((d:any)=>{
      const list = Array.isArray(d?.defaultCommandBlacklist) ? d.defaultCommandBlacklist : [];
      setDefaultBlacklist(list.map((s:string)=>stripCaret(String(s))).join("\n"));
    }).catch(()=>{});
    api.securityGet().then((sec:any)=>{
      if(!sec || sec.ok===false) return;
      const toDisplay = (arr:any)=> Array.isArray(arr) ? arr.map((s:string)=>stripCaret(String(s))).join("\n") : "";
      const toPaths = (arr:any)=> Array.isArray(arr) ? arr.join(", ") : "";
      form.setFieldsValue({
        whitelist: toDisplay(sec.commandWhitelist || []),
        blacklist: toDisplay(sec.commandBlacklist || []),
        allowedLocalPaths: toPaths(sec.allowedLocalPaths || []),
        allowedRemotePaths: toPaths(sec.allowedRemotePaths || []),
      });
    }).catch(()=>{}).finally(()=>setLoading(false));
  };
  const handleSave = async()=>{
    try{
      await form.validateFields();
    } catch{ return; }
    const v:any = form.getFieldsValue();
    const payload = {
      commandWhitelist: (v.whitelist||"").split("\n").map((s:string)=>s.trim()).filter(Boolean),
      commandBlacklist: (v.blacklist||"").split("\n").map((s:string)=>s.trim()).filter(Boolean),
      allowedLocalPaths: v.allowedLocalPaths || "",
      allowedRemotePaths: v.allowedRemotePaths || "",
    };
    setSaving(true);
    try{
      const res:any = await api.securitySave(payload);
      if(res?.ok===false) throw new Error(res.message || "保存失败");
      message.success("安全策略已保存");
    } catch(e:any){
      message.error(e?.message || "保存失败");
    } finally{ setSaving(false); }
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <Typography.Title level={4} style={{ margin:0, fontWeight:700 }}><SafetyCertificateOutlined style={{ color:"#1677ff", marginRight:8 }}/>安全策略</Typography.Title>
      <Alert type="info" showIcon message="策略说明" description="远程路径以 POSIX 校验为准（Windows 输入 C:\ 亦按 / 校验）；白名单与路径在『连接管理-高级-按连接安全覆盖』留空时跟随全局，配置了则以连接级为准；黑名单为全局与连接级叠加，全局高危拦截不可被连接级清空。" style={{ borderRadius:12 }} />
      <Card style={{ borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)" }} loading={loading}>
        <Form form={form} layout="vertical">
          <Form.Item name="whitelist" label="命令白名单（正则表达式，每行一条）" extra="留空表示不限制，建议按需配置；无需输入行首 ^，系统会自动锚定到命令开头" rules={[{validator:validateRegex}]}><Input.TextArea rows={4} placeholder={"例如：\nls.*\ngit status\ncat\\s+.*"} style={{ borderRadius:10 }} /></Form.Item>
          <Form.Item
            name="blacklist"
            label={<span>命令黑名单（正则表达式） <Typography.Text type="danger" style={{ fontSize:12, fontWeight:600 }}><WarningOutlined style={{ marginRight:4 }}/>高危拦截</Typography.Text></span>}
            extra="默认已屏蔽高危操作，可按需增删；无需输入行首 ^，系统会自动为每条规则补 ^ 锚定"
            rules={[{validator:validateRegex}]}
          >
            <Input.TextArea rows={7} placeholder={defaultBlacklist || "rm\\s+.*\nshutdown.*"} style={{ borderRadius:10, fontFamily:"ui-monospace, monospace", fontSize:13, borderColor:token.colorError, background:token.colorErrorBg }} />
          </Form.Item>
          <div style={{ marginTop:-8, marginBottom:16, display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" }}>
            <Typography.Text type="danger" style={{ fontSize:12, fontWeight:600 }}><WarningOutlined /> 当前高危拦截预览：</Typography.Text>
            {previewList.length===0 ? <Typography.Text type="secondary" style={{ fontSize:12 }}>（空）</Typography.Text> : previewList.map((p,i)=>(
              <Tag key={i} color="error" style={{ fontFamily:"ui-monospace, monospace", fontSize:12, padding:"2px 8px", borderRadius:6, fontWeight:600 }} icon={<WarningOutlined />}>{p}</Tag>
            ))}
          </div>
          <Space style={{ marginBottom:16 }}>
            <Button icon={<ReloadOutlined />} disabled={!defaultBlacklist} onClick={() => form.setFieldsValue({ blacklist: defaultBlacklist })}>恢复默认黑名单</Button>
            <Typography.Text type="secondary" style={{ fontSize:12 }}>默认 7 条：rm / shutdown / reboot / halt / poweroff / mkfs / dd（自动补 ^）</Typography.Text>
          </Space>
          <Form.Item name="allowedLocalPaths" label="允许的本地路径（逗号分隔）"><Input placeholder="/tmp, /home/user" style={{ borderRadius:10 }} /></Form.Item>
          <Form.Item name="allowedRemotePaths" label="允许的远程路径（逗号分隔）"><Input placeholder="/home, /tmp" style={{ borderRadius:10 }} /></Form.Item>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave} style={{ borderRadius:10, marginTop:8 }}>保存安全策略</Button>
          <Button loading={loading} onClick={loadSecurity} style={{ borderRadius:10, marginTop:8, marginLeft:8 }}>刷新</Button>
        </Form>
      </Card>
    </div>
  );
}
