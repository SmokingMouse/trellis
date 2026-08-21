// Preset definitions for common LLM providers and models.
// Used by ModelConfigPanel for 1-click provider templates and model suggestions.

export type ProviderPreset = {
  id: string;
  name: string;
  label: string;
  badge: string;
  description: string;
  anthropic_url?: string;
  openai_url?: string;
  api_key_env: string;
  defaultModels: string[];
  suggestedModels: string[];
  docUrl?: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "deepseek",
    label: "DeepSeek (深度求索)",
    badge: "DeepSeek",
    description: "DeepSeek 官方 API（支持 Anthropic 兼容端点与 OpenAI 兼容端点）",
    anthropic_url: "https://api.deepseek.com/anthropic",
    openai_url: "https://api.deepseek.com/v1",
    api_key_env: "DEEPSEEK_API_KEY",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
    suggestedModels: [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ],
  },
  {
    id: "kimi",
    name: "kimi",
    label: "Moonshot / Kimi (月之暗面)",
    badge: "Kimi",
    description: "Moonshot Kimi 官方 API",
    anthropic_url: "https://api.moonshot.cn/anthropic",
    openai_url: "https://api.moonshot.cn/v1",
    api_key_env: "MOONSHOT_API_KEY",
    defaultModels: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    suggestedModels: [
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
      "kimi-k1.5-preview",
    ],
  },
  {
    id: "qwen",
    name: "qwen",
    label: "通义千问 (DashScope)",
    badge: "Qwen",
    description: "阿里云百炼 / 通义千问 API",
    anthropic_url: "https://dashscope.aliyuncs.com/anthropic",
    openai_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api_key_env: "DASHSCOPE_API_KEY",
    defaultModels: ["qwen-max", "qwen-plus", "qwen-turbo"],
    suggestedModels: [
      "qwen-max",
      "qwen-plus",
      "qwen-turbo",
      "qwen-coder-plus",
      "qwen-2.5-72b-instruct",
    ],
  },
  {
    id: "zhipu",
    name: "zhipu",
    label: "智谱 GLM (BigModel)",
    badge: "GLM",
    description: "智谱 AI GLM 系列模型",
    anthropic_url: "https://open.bigmodel.cn/api/anthropic",
    openai_url: "https://open.bigmodel.cn/api/paas/v4",
    api_key_env: "ZHIPU_API_KEY",
    defaultModels: ["glm-4-plus", "glm-4-flash", "glm-4-air"],
    suggestedModels: [
      "glm-4-plus",
      "glm-4-flash",
      "glm-4-air",
      "glm-4-long",
      "glm-zero-preview",
    ],
  },
  {
    id: "minimax",
    name: "minimax",
    label: "MiniMax (名之梦)",
    badge: "MiniMax",
    description: "MiniMax 官方 API",
    anthropic_url: "https://api.minimax.chat/anthropic",
    openai_url: "https://api.minimax.chat/v1",
    api_key_env: "MINIMAX_API_KEY",
    defaultModels: ["abab6.5s-chat", "minimax-text-01"],
    suggestedModels: [
      "abab6.5s-chat",
      "abab6.5t-chat",
      "minimax-text-01",
    ],
  },
  {
    id: "ark",
    name: "ark",
    label: "火山引擎 Ark (字节跳动)",
    badge: "Ark",
    description: "火山引擎方舟平台 / 豆包大模型",
    anthropic_url: "https://ark.cn-beijing.volces.com/api/anthropic",
    openai_url: "https://ark.cn-beijing.volces.com/api/v3",
    api_key_env: "ARK_API_KEY",
    defaultModels: ["doubao-pro-32k", "doubao-lite-32k"],
    suggestedModels: [
      "doubao-pro-32k",
      "doubao-pro-128k",
      "doubao-lite-32k",
      "doubao-lite-128k",
    ],
  },
  {
    id: "siliconflow",
    name: "siliconflow",
    label: "SiliconFlow (硅基流动)",
    badge: "SiliconFlow",
    description: "硅基流动模型云服务",
    anthropic_url: "https://api.siliconflow.cn/anthropic",
    openai_url: "https://api.siliconflow.cn/v1",
    api_key_env: "SILICONFLOW_API_KEY",
    defaultModels: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1"],
    suggestedModels: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "THUDM/glm-4-9b-chat",
    ],
  },
  {
    id: "openrouter",
    name: "openrouter",
    label: "OpenRouter",
    badge: "OpenRouter",
    description: "全球模型聚合网关",
    anthropic_url: "https://openrouter.ai/api/v1/anthropic",
    openai_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    defaultModels: [
      "anthropic/claude-3.7-sonnet",
      "anthropic/claude-3.5-haiku",
      "deepseek/deepseek-r1",
    ],
    suggestedModels: [
      "anthropic/claude-3.7-sonnet",
      "anthropic/claude-3.5-haiku",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "deepseek/deepseek-r1",
      "deepseek/deepseek-chat",
      "google/gemini-2.0-flash-001",
    ],
  },
  {
    id: "ollama",
    name: "ollama",
    label: "Ollama (本地运行)",
    badge: "Ollama",
    description: "本地运行的开源大模型",
    anthropic_url: "http://localhost:11434/anthropic",
    openai_url: "http://localhost:11434/v1",
    api_key_env: "OLLAMA_API_KEY",
    defaultModels: ["llama3.3", "qwen2.5-coder:32b"],
    suggestedModels: [
      "llama3.3",
      "qwen2.5-coder:32b",
      "deepseek-r1:32b",
      "deepseek-r1:14b",
      "mistral:latest",
    ],
  },
  {
    id: "openai",
    name: "openai",
    label: "OpenAI (Direct / 代理)",
    badge: "OpenAI",
    description: "OpenAI 官方或反向代理端点（仅 openai_url）",
    openai_url: "https://api.openai.com/v1",
    api_key_env: "OPENAI_API_KEY",
    defaultModels: ["gpt-4o", "gpt-4o-mini"],
    suggestedModels: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
  },
];

/** Extract a provider badge / display name from a ProviderId. */
export function getProviderBadge(id: string): string {
  if (id === "mock") return "Mock";
  if (id.startsWith("codex")) return "Codex";
  if (id.startsWith("claude-") || id === "claude") return "Claude";
  if (id.includes(":")) {
    const prov = id.split(":")[0];
    const match = PROVIDER_PRESETS.find(
      (p) => p.id === prov || p.name.toLowerCase() === prov.toLowerCase(),
    );
    return match?.badge ?? prov;
  }
  return "Claude";
}

/** Human-friendly context window formatting (e.g. 1M, 200K, 128K). */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(0)}K`;
  }
  return `${tokens}`;
}
