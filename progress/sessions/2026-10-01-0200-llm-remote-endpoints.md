# 2026-10-01 接通 sm-toolkit 远端 endpoints

## 做了什么
- llm ^0.4→^0.8 + overrides 钉住 agent 的嵌套 llm；面板远端模式写 endpoints.local.yaml；上线 175c3c1
- sm-toolkit 8c7505f：agent 依赖 llm ^0.8.0，版本 0.8.5，未发布

## 决定
- [decision] 面板远端模式只写本机 overlay（用户拍板）；拒绝 push 远端、拒绝只读
- [decision] agent 0.8.5 暂不发 npm，trellis 用 overrides 顶上

## Next
发 @smokingmouse/agent@0.8.5 后删 package.json overrides 与 vendor-agent-server.test.ts 的豁免
