"use client";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { ModelConfigPanel } from "@/components/ModelConfigPanel";
import { AuthHealthCard } from "@/components/AuthHealthCard";
import { LabelModelCard } from "@/components/LabelModelCard";
import { Icon, IconButton, PageHeader } from "@/components/ui";

// S89: 「模型与服务商」tab。内容与 ModelPicker 下拉底部那个 modal 完全同一个组件
// （components/ModelConfigPanel.tsx），只是外壳不同 —— modal 有「关闭」，tab 没有。
// S95: 顶部加 CLI 授权状态卡 —— 只进 tab、不进 modal（下拉那侧是「换模型」的语境，
// 授权健康属于管理台）。
// S111: 底部加打标/起题模型卡 —— 同属管理台语境，不进 modal。
// W4: 页头刷新 = 三块整体重挂（各自重新拉数据）。ModelConfigPanel 同时被 ModelPicker
// 的 modal 使用，不在本页的改动范围里，添加服务商的入口仍在它内部。
export default function ModelsSettingsPage() {
  const [epoch, setEpoch] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="模型与服务商"
        subtitle="本机 CLI 登录态、各服务商端点与模型列表"
        actions={
          <IconButton label="刷新" onClick={() => setEpoch((n) => n + 1)}>
            <Icon icon={RefreshCw} />
          </IconButton>
        }
      />
      <AuthHealthCard key={`auth-${epoch}`} />
      <div className="rounded-card border border-line bg-surface overflow-hidden">
        <ModelConfigPanel key={`cfg-${epoch}`} />
      </div>
      <LabelModelCard key={`label-${epoch}`} />
    </div>
  );
}
