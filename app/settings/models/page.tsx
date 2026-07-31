"use client";
import { ModelConfigPanel } from "@/components/ModelConfigPanel";

// S89: 「模型与 Provider」tab。内容与 ModelPicker 下拉底部那个 modal 完全同一个组件
// （components/ModelConfigPanel.tsx），只是外壳不同 —— modal 有「关闭」，tab 没有。
export default function ModelsSettingsPage() {
  return (
    <div className="max-w-3xl rounded-card border border-line bg-surface shadow-raise overflow-hidden">
      <ModelConfigPanel />
    </div>
  );
}
