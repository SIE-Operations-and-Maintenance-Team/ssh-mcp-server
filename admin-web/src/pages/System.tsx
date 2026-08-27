import React, { useEffect, useState } from "react";
import { Form, Input, InputNumber, Button, Select, message, Card, Descriptions, Typography, Tag, Space, Switch, Popconfirm, Modal, Row, Col } from "antd";
import { DashboardOutlined, ThunderboltOutlined, CheckCircleOutlined, LoginOutlined, SyncOutlined, PoweroffOutlined } from "@ant-design/icons";
import { api } from "../api/client";
export default function System(){
  const [info,setInfo]=useState<any>({});
  const [form]=Form.useForm();
  const [auto,setAuto]=useState<{enabled:boolean;supported:boolean}>({enabled:false,supported:true});
  const [autoBusy,setAutoBusy]=useState(false);
  const [upd,setUpd]=useState<any>(null);
  const [checking,setChecking]=useState(false);
  const [registering,setRegistering]=useState(false);
  const [configPort,setConfigPort]=useState<number|null>(null);
  const [portInput,setPortInput]=useState<number|null>(null);
  const [portSaving,setPortSaving]=useState(false);

  const load=async()=> setInfo(await api.systemInfo());
  const loadAuto=async()=>{ try{ setAuto(await api.autostartGet()); }catch{} };
  const loadUpdate=async()=>{ try{ setUpd(await api.updateStatus()); }catch{} };
  useEffect(()=>{ load(); loadAuto(); loadUpdate(); },[]);
  useEffect(()=>{ api.settingsGet().then((s:any)=>{ setConfigPort(s?.port ?? null); setPortInput(s?.port ?? null); }).catch(()=>{}); },[]);

  const savePort=async()=>{
    const p = portInput ?? configPort;
    if(p==null || !Number.isInteger(p) || p<1 || p>65535){ message.error("端口须为 1-65535 的整数"); return; }
    setPortSaving(true);
    try{
      const r:any=await api.settingsSave({ port: p });
      if(r?.ok===false) throw new Error(r.message||"保存失败");
      setConfigPort(p);
      message.success(`端口已保存为 ${p}，重启后生效`);
    }catch(e:any){ message.error(e?.message||"保存端口失败"); }
    finally{ setPortSaving(false); }
  };

  const register=async()=>{
    setRegistering(true);
    try{
      const v=form.getFieldsValue();
      const r:any=await api.registerMcp({client:v.client||"claude", scope:v.scope||"user", serverName:v.serverName||"ssh-mcp-server", port: info.port, force: v.force});
      if(r.conflict) message.warning(`存在冲突：${r.path} 已存在，请勾选强制覆盖后重试`); else if(r.ok) message.success(`已写入 ${r.path}`); else message.error(r.message||"操作失败");
    }catch(e:any){
      message.error(e?.message||"注册失败");
    }finally{
      setRegistering(false);
    }
  };

  const toggleAuto=async(checked:boolean)=>{
    setAutoBusy(true);
    try{
      const r:any=await api.autostartSave(checked);
      setAuto({enabled:!!r.enabled,supported:true});
      message.success(r.enabled?"已启用登录自启动。":"已关闭登录自启动。");
    }catch(e:any){
      setAuto((a)=>({...a})); // 失败回滚开关视觉状态
      message.error(e?.message||"设置自启动失败");
    }finally{ setAutoBusy(false); }
  };

  const doCheck=async()=>{
    setChecking(true);
    try{
      const s:any=await api.updateCheck();
      setUpd((prev:any)=>({...prev,...s}));
      if(s.error) message.error(`检查失败：${s.error}`);
      else if(s.hasUpdate) message.info(`发现新版本 ${s.targetVersion}`);
      else message.success("已是最新版本");
    }catch(e:any){ message.error(e?.message||"检查更新失败"); }
    finally{ setChecking(false); }
  };

  const doApply=async()=>{
    try{ await api.updateApply(); message.info("正在下载并安装更新，完成后自动重启，请稍候…"); }
    catch(e:any){ message.error(e?.message||"应用更新失败"); }
  };

  const doRestart=()=>{
    const portChanged = configPort!=null && info.port && configPort!==info.port;
    Modal.confirm({
      title:"重启服务",
      content: portChanged
        ? `将以新端口 ${configPort} 启动。MCP 客户端需改连：http://127.0.0.1:${configPort}/mcp`
        : "将按当前配置重新启动（读取最新端口与配置）。",
      okText:"重启",
      cancelText:"取消",
      onOk:async()=>{
        try{ await api.restart(); }catch{ /* 旧实例退出导致的网络错误可忽略 */ }
        message.info(portChanged?`正在重启，新地址 http://127.0.0.1:${configPort}/admin，请稍候手动访问。`:"正在重启，请稍候刷新页面。");
      },
    });
  };

  // 更新提示语状态机（对齐 MCP-DB-Tools 的语义）
  const updateHint = !upd ? "加载中…"
    : !upd.configured ? "未配置更新源。需运维设置后才能检查更新。"
    : !upd.installed ? "当前为本地开发模式运行（非 npm 安装包），无法在线更新。安装正式版后可用。"
    : upd.error ? `检查失败：${upd.error}`
    : !upd.checked ? "尚未检查更新，点“检查更新”。"
    : upd.hasUpdate ? `发现新版本 ${upd.targetVersion}（当前 ${upd.currentVersion}），点“安装并重启”应用。`
    : "已是最新版本。";
  const canCheck = !!upd?.configured && !!upd?.installed;
  const canApply = canCheck && !!upd?.hasUpdate && !upd?.error;

  return (
    <div style={{display:"flex", flexDirection:"column", gap:16}}>
      <Typography.Title level={4} style={{margin:0,fontWeight:700}}><DashboardOutlined style={{color:"#1677ff", marginRight:8}}/>系统</Typography.Title>
      <Card style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)", background:"linear-gradient(135deg, #f0f7ff 0%, #ffffff 100%)"}} bodyStyle={{padding:20}}>
        <Space style={{marginBottom:12}}>
          <Tag color="blue" icon={<ThunderboltOutlined/>}>运行中</Tag>
          <Tag>本地可信</Tag>
        </Space>
        <Descriptions column={1} labelStyle={{width:120,color:"#6b7280"}} contentStyle={{fontWeight:600}}>
          <Descriptions.Item label="服务端口">{info.port||"-"}</Descriptions.Item>
          <Descriptions.Item label="版本号">{info.version||"-"}</Descriptions.Item>
          <Descriptions.Item label="运行平台">{info.platform||"-"}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title={<span><CheckCircleOutlined style={{color:"#1677ff", marginRight:8}}/>一键注册</span>} style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)"}}>
        <Form form={form} layout="vertical">
          <Form.Item name="client" label="客户端" initialValue="claude"><Select options={[{value:"claude",label:"Claude"},{value:"vscode",label:"VS Code"},{value:"cursor",label:"Cursor"}]} style={{borderRadius:10}}/></Form.Item>
          <Form.Item name="scope" label="作用域" initialValue="user"><Select options={[{value:"user",label:"用户级"},{value:"project",label:"项目级"}]} style={{borderRadius:10}}/></Form.Item>
          <Form.Item name="serverName" label="服务名称" initialValue="ssh-mcp-server"><Input placeholder="例如：ssh-mcp-server" style={{borderRadius:10}}/></Form.Item>
          <Form.Item name="force" label="强制覆盖" valuePropName="checked" extra="目标文件已存在同名服务配置时覆盖写入（否则提示冲突）"><Switch /></Form.Item>
          <Button type="primary" loading={registering} onClick={register} style={{borderRadius:10}}>注册 / 更新</Button>
        </Form>
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title={<span><LoginOutlined style={{color:"#1677ff", marginRight:8}}/>登录自启动</span>} style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)", height:"100%"}}>
            <Space direction="vertical" size={8}>
              <Space>
                <Switch checked={auto.enabled} disabled={!auto.supported||autoBusy} onChange={toggleAuto} />
                <span>开机登录后自动启动</span>
              </Space>
              <Typography.Text type="secondary" style={{fontSize:12}}>
                {auto.supported ? "勾选后写入注册表 HKCU Run（当前用户登录时启动），取消则移除。无需管理员权限。" : "登录自启动仅支持 Windows。"}
              </Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title={<span><SyncOutlined style={{color:"#1677ff", marginRight:8}}/>应用更新</span>} style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)", height:"100%"}}>
            <Space direction="vertical" size={12}>
              <Typography.Text>当前版本 <Typography.Text code>{upd?.currentVersion||info.version||"?"}</Typography.Text>。通过 npm registry 检查并安装新版本。</Typography.Text>
              <Space>
                <Button type="primary" loading={checking} disabled={!canCheck} onClick={doCheck}>检查更新</Button>
                <Popconfirm title="安装并重启" description="将下载并安装新版本，随后自动重启服务。" okText="安装" cancelText="取消" onConfirm={doApply}>
                  <Button danger ghost disabled={!canApply}>安装并重启</Button>
                </Popconfirm>
              </Space>
              <Typography.Text type={upd?.error?"danger":"secondary"} style={{fontSize:12}}>{updateHint}</Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={24}>
          <Card title={<span><PoweroffOutlined style={{color:"#1677ff", marginRight:8}}/>应用控制</span>} style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)"}}>
            <Space direction="vertical" size={8}>
              <Space>
                <span style={{fontWeight:600}}>管理端口：</span>
                <InputNumber min={1} max={65535} value={portInput ?? configPort} onChange={(v)=>setPortInput(v as number|null)} style={{width:140}} placeholder="61823" />
                <Button loading={portSaving} onClick={savePort}>保存端口</Button>
                {configPort!=null && info.port && configPort!==info.port && <Tag color="orange">重启后生效: {configPort}</Tag>}
              </Space>
              <Button type="primary" onClick={doRestart}>重启服务</Button>
              <Typography.Text type="secondary" style={{fontSize:12}}>修改端口保存后需重启生效；重启会以最新配置重新监听。退出请用进程管理器或关闭启动方式。</Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
