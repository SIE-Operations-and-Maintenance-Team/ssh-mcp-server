import React, { useEffect, useState } from "react";
import { Table, Button, message, Popconfirm, Card, Typography, Empty, Space } from "antd";
import { CloudServerOutlined, PlusOutlined, HistoryOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
export default function Backups(){
  const [rows,setRows]=useState<any[]>([]);
  const [loading,setLoading]=useState(false);
  const [snapBusy,setSnapBusy]=useState(false);
  const [restoringId,setRestoringId]=useState<string|null>(null);
  const load=async()=>{ setLoading(true); try{ setRows(await api.backups() as any[]); } finally{ setLoading(false); } };
  useEffect(()=>{load();},[]);
  const snapshot=async()=>{
    setSnapBusy(true);
    try{ await api.snapshot(); message.success("已创建快照"); await load(); }
    catch(e:any){ message.error(e?.message||"快照失败"); }
    finally{ setSnapBusy(false); }
  };
  const restore=async(rec:any)=>{
    setRestoringId(rec.id);
    try{ await api.restore(rec.id); message.success("已恢复"); await load(); }
    catch(e:any){ message.error(e?.message||"恢复失败"); }
    finally{ setRestoringId(null); }
  };
  return (
    <div style={{display:"flex", flexDirection:"column", gap:16}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
        <Typography.Title level={4} style={{margin:0,fontWeight:700}}><HistoryOutlined style={{color:"#1677ff", marginRight:8}}/>备份恢复</Typography.Title>
        <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} loading={snapBusy} onClick={snapshot}>立即快照</Button>
          </Space>
      </div>
      <Card style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)"}} bodyStyle={{padding:0}}>
        <Table loading={loading} rowKey="id" dataSource={rows} locale={{emptyText:<Empty description="暂无备份" image={Empty.PRESENTED_IMAGE_SIMPLE}/>}} pagination={{pageSize:8, showTotal:(t)=>`共 ${t} 条`}} columns={[{title:"名称",dataIndex:"name",render:(v:string)=><span style={{fontFamily:"ui-monospace, monospace", fontSize:13}}><CloudServerOutlined style={{marginRight:6, color:"#1677ff"}}/>{v}</span>},{title:"时间",dataIndex:"ts",render:(v:number)=> v? new Date(v).toLocaleString():"-"},{title:"操作",width:140,render:(_:any,rec:any)=>(<Popconfirm title="确认恢复此备份？会先自动快照当前配置" okText="确认恢复" cancelText="取消" onConfirm={()=>restore(rec)}><Button type="primary" ghost loading={restoringId===rec.id}>恢复</Button></Popconfirm>)}]} />
      </Card>
    </div>
  );
}
