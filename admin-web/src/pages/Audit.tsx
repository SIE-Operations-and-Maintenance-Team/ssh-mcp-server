import React, { useEffect, useState } from "react";
import { Table, Input, Card, Tag, Typography, Modal, Descriptions, Button } from "antd";
import { AuditOutlined, SearchOutlined, FileSearchOutlined } from "@ant-design/icons";
import { api } from "../api/client";
export default function Audit(){
  const [rows,setRows]=useState<any[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [q,setQ]=useState("");
  const [loading,setLoading]=useState(false);
  const [detail,setDetail]=useState<any|null>(null);
  const load=async(p=1)=>{ setLoading(true); try{ const r:any=await api.audit({page:p,pageSize:10,q}); setRows(r.rows||[]); setTotal(r.total||0); } finally{ setLoading(false); } };
  useEffect(()=>{ load(page); },[page,q]);
  return (
    <div style={{display:"flex", flexDirection:"column", gap:16}}>
      <Typography.Title level={4} style={{margin:0,fontWeight:700}}><AuditOutlined style={{color:"#1677ff", marginRight:8}}/>审计日志</Typography.Title>
      <Card style={{borderRadius:16, boxShadow:"0 2px 12px rgba(0,0,0,0.04)"}} bodyStyle={{padding:16}}>
        <Input.Search
          placeholder="搜索连接 / 工具 / 命令"
          loading={loading}
          enterButton={<><SearchOutlined /> 搜索</>}
          // 只更新状态，请求交给上方 useEffect——避免手动 load 捕获旧 q 造成双重请求与竞态
          onSearch={(v)=>{ setQ(v); setPage(1); }}
          style={{ maxWidth:420, marginBottom:16 }}
          allowClear
        />
        <Table loading={loading} rowKey="id" dataSource={rows}
          onRow={(rec)=>({ onClick:()=>setDetail(rec), style:{cursor:"pointer"} })}
          pagination={{current:page,pageSize:10,total,onChange:setPage, showTotal:(t)=>`共 ${t} 条`}}
          columns={[
            {title:"时间",dataIndex:"ts",width:170,render:(v:number)=>new Date(v).toLocaleString()},
            {title:"连接",dataIndex:"connection",width:130,render:(v:string)=><Tag color="geekblue" style={{borderRadius:20}}>{v||"-"}</Tag>},
            {title:"工具",dataIndex:"tool",width:140,render:(v:string)=><Tag>{v}</Tag>},
            {title:"命令 / 路径",dataIndex:"sql",ellipsis:true,render:(v:string)=> v ? <code style={{fontSize:12}}>{v}</code> : <Typography.Text type="secondary">-</Typography.Text>},
            {title:"状态",dataIndex:"status",width:90,render:(v:string)=> v==="ok"? <Tag color="success">成功</Tag> : v==="fail"? <Tag color="error">失败</Tag> : <Tag>{v}</Tag>},
            {title:"操作",width:80,render:(_:any,rec:any)=><Button type="link" size="small" icon={<FileSearchOutlined />} onClick={(e)=>{ e.stopPropagation(); setDetail(rec); }}>详情</Button>},
          ]} />
      </Card>
      <Modal
        open={!!detail}
        title={<span><FileSearchOutlined style={{color:"#1677ff", marginRight:8}}/>审计详情</span>}
        onCancel={()=>setDetail(null)}
        footer={<Button type="primary" onClick={()=>setDetail(null)}>关闭</Button>}
        width={640}
      >
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="时间">{new Date(detail.ts).toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="连接"><Tag color="geekblue" style={{borderRadius:20}}>{detail.connection||"-"}</Tag></Descriptions.Item>
            <Descriptions.Item label="工具"><Tag>{detail.tool}</Tag></Descriptions.Item>
            <Descriptions.Item label="状态">{detail.status==="ok"? <Tag color="success">成功</Tag> : <Tag color="error">失败</Tag>}</Descriptions.Item>
            <Descriptions.Item label="命令 / 路径">
              {detail.sql
                ? <pre style={{margin:0, maxWidth:"100%", whiteSpace:"pre-wrap", wordBreak:"break-all", fontFamily:"ui-monospace, monospace", fontSize:12}}>{detail.sql}</pre>
                : <Typography.Text type="secondary">（无记录）</Typography.Text>}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}
