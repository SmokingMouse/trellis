"use client";
import { ModelConfigPanel } from "@/components/ModelConfigPanel";
import { AuthHealthCard } from "@/components/AuthHealthCard";
import { LabelModelCard } from "@/components/LabelModelCard";

// S89: 「模型与 Provider」tab。内容与 ModelPicker 下拉底部那个 modal 完全同一个组件
// （components/ModelConfigPanel.tsx），只是外壳不同 —— modal 有「关闭」，tab 没有。
// S95: 顶部加 CLI 授权状态卡 —— 只进 tab、不进 modal（下拉那侧是「换模型」的语境，
// 授权健康属于管理台）。
// S111: 底部加打标/起题模型卡 —— 同属管理台语境，不进 modal。
export default function ModelsSettingsPage() {
  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <AuthHealthCard />
      <div className="rounded-card border border-line bg-surface shadow-raise overflow-hidden">
        <ModelConfigPanel />
      </div>
      <LabelModelCard />
    </div>
  );
}
