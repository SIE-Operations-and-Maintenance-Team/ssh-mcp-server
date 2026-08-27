import React, { useEffect, useState } from "react";
import { Table, Input, Card, Tag, Typography } from "antd";
import { AuditOutlined, SearchOutlined } from "@ant-design/icons";
import { api } from "../api/client";
export default function Audit(){
  const [rows,setRows]=useState<any[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [q,setQ]=useState("");
  const [loading,setLoading]=useState(false);
  const load=async(p=1)=>{ setLoading(true); try{ const r:any=await api.audit({page:p,pageSize:10,q}); setRows(r.rows||[]); setTotal(r.total||0); } finally{ setLoading(false); } };
  useEffect(()=>{ load(page); },[page,q]);
  return (
    <div style={{display:"flex", flexDirection:"column", gap:16}}>
      <Typography.Title level={4} style={{margin:0,fontWeight:700}}><AuditOutlined style={{color:"#1677ff", marginRight:8}}/>审计日志</Typography.Title>
      <Card style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)"}} bodyStyle={{padding:16}}>
        <Input.Search
          placeholder="搜索连接 / 工具 / 状态"
          loading={loading}
          enterButton={<><SearchOutlined /> 搜索</>}
          // 只更新状态，请求交给上方 useEffect——避免手动 load 捕获旧 q 造成双重请求与竞态
          onSearch={(v)=>{ setQ(v); setPage(1); }}
          style={{ maxWidth:420, marginBottom:16 }}
          allowClear
        />
        <Table loading={loading} rowKey="id" dataSource={rows} pagination={{current:page,pageSize:10,total,onChange:setPage, showTotal:(t)=>`共 ${t} 条`}} columns={[{title:"时间",dataIndex:"ts",render:(v:number)=>new Date(v).toLocaleString()},{title:"连接",dataIndex:"connection",render:(v:string)=><Tag color="geekblue" style={{borderRadius:20}}>{v||"-"}</Tag>},{title:"工具",dataIndex:"tool",render:(v:string)=><Tag>{v}</Tag>},{title:"状态",dataIndex:"status",render:(v:string)=> v==="ok"? <Tag color="success">成功</Tag> : v==="fail"? <Tag color="error">失败</Tag> : <Tag>{v}</Tag>}]} />
      </Card>
    </div>
  );
}
