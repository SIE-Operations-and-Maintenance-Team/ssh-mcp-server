import React, { useEffect, useState } from "react";
import { Form, InputNumber, Switch, Button, Card, Typography, Divider, message, Space, Alert, Select } from "antd";
import { SettingOutlined, SaveOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { api } from "../api/client";

export default function Settings() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const backupsAutoEnabled = Form.useWatch("backupsAutoEnabled", form);

  const load = async () => {
    setLoading(true);
    try {
      const s: any = await api.settingsGet();
      form.setFieldsValue({
        preConnect: s.preConnect,
        auditEnabled: s.audit?.enabled,
        auditRetentionDays: s.audit?.retentionDays,
        auditLogResults: s.audit?.logResults,
        backupsRetentionDays: s.backups?.retentionDays,
        backupsMaxCount: s.backups?.maxCount,
        backupsAutoEnabled: s.backups?.autoEnabled,
        backupsIntervalHours: s.backups?.intervalHours ?? 24,
      });
    } catch (e: any) {
      message.error("加载设置失败：" + String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    try {
      await form.validateFields();
    } catch {
      return;
    }
    const v: any = form.getFieldsValue();
    const payload: any = {};
    if (v.preConnect !== undefined) payload.preConnect = Boolean(v.preConnect);
    payload.audit = {
      enabled: v.auditEnabled,
      retentionDays: v.auditRetentionDays,
      logResults: v.auditLogResults,
    };
    payload.backups = {
      retentionDays: v.backupsRetentionDays,
      maxCount: v.backupsMaxCount,
      autoEnabled: Boolean(v.backupsAutoEnabled),
      intervalHours: v.backupsIntervalHours != null && !Number.isNaN(Number(v.backupsIntervalHours)) ? Number(v.backupsIntervalHours) : undefined,
    };
    // 清理 undefined
    if (payload.audit.retentionDays == null) delete payload.audit.retentionDays;
    if (payload.audit.enabled == null) delete payload.audit.enabled;
    if (payload.audit.logResults == null) delete payload.audit.logResults;
    if (payload.backups.retentionDays == null) delete payload.backups.retentionDays;
    if (payload.backups.maxCount == null) delete payload.backups.maxCount;
    if (payload.backups.intervalHours == null) delete payload.backups.intervalHours;
    setSaving(true);
    try {
      const res: any = await api.settingsSave(payload);
      if (res?.ok === false) throw new Error(res.message || "保存失败");
      message.success("设置已保存");
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Typography.Title level={4} style={{ margin: 0, fontWeight: 700 }}>
        <SettingOutlined style={{ color: "#1677ff", marginRight: 8 }} />
        设置
      </Typography.Title>
      <Typography.Text type="secondary">集中配置预连接、审计与备份（管理端口在“系统”页）</Typography.Text>
      <Card style={{ borderRadius: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }} loading={loading}>
        <Form form={form} layout="vertical">
          <Typography.Text strong style={{ fontSize: 13, color: "#1677ff" }}>
            <ThunderboltOutlined style={{ marginRight: 6 }} />
            服务
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Form.Item name="preConnect" label="启动时预连接" valuePropName="checked" extra="开启后服务启动时自动连接所有已配置节点">
            <Switch />
          </Form.Item>

          <Typography.Text strong style={{ fontSize: 13, color: "#1677ff", marginTop: 8, display: "block" }}>
            审计
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Form.Item name="auditEnabled" label="启用审计" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="auditLogResults" label="记录成功执行" valuePropName="checked" extra="开启后成功执行的命令/传输也记入审计日志（含命令与路径，可在审计日志页查看详情）；关闭后仅记录失败操作">
            <Switch />
          </Form.Item>
          <Form.Item name="auditRetentionDays" label="审计保留天数">
            <InputNumber min={1} max={365} addonAfter="天" style={{ width: "100%", borderRadius: 10 }} />
          </Form.Item>

          <Typography.Text strong style={{ fontSize: 13, color: "#1677ff", marginTop: 8, display: "block" }}>
            备份
          </Typography.Text>
          <Divider style={{ margin: "12px 0" }} />
          <Form.Item name="backupsRetentionDays" label="备份保留天数">
            <InputNumber min={1} max={365} addonAfter="天" style={{ width: "100%", borderRadius: 10 }} />
          </Form.Item>
          <Form.Item name="backupsMaxCount" label="最大备份数">
            <InputNumber min={1} style={{ width: "100%", borderRadius: 10 }} />
          </Form.Item>
          <Form.Item name="backupsAutoEnabled" label="定时自动备份" valuePropName="checked" extra="开启后按间隔自动快照，无需手动操作">
            <Switch />
          </Form.Item>
          <Form.Item
            name="backupsIntervalHours"
            label="自动备份间隔"
            rules={backupsAutoEnabled ? [{ required: true, message: "请选择间隔" }] : []}
          >
            <Select
              disabled={!backupsAutoEnabled}
              placeholder="请选择间隔"
              style={{ width: "100%" }}
              options={[
                { value: 1, label: "每小时" },
                { value: 6, label: "每 6 小时" },
                { value: 12, label: "每 12 小时" },
                { value: 24, label: "每天" },
                { value: 168, label: "每周" },
                { value: 336, label: "每 2 周" },
                { value: 720, label: "每 30 天" },
              ]}
            />
          </Form.Item>

          <Space>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save} style={{ borderRadius: 10, marginTop: 8 }}>
              保存设置
            </Button>
            <Button loading={loading} onClick={load} style={{ borderRadius: 10, marginTop: 8 }}>
              刷新
            </Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
