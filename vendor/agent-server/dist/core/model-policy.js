import { ErrorCode, ProtocolError } from "../protocol/index.js";
import { resolveClaudeModel } from "@smokingmouse/agent";
export const DEFAULT_DENIED_MODELS = ["fable", "claude-fable*"];
/** Plain entries match prefixes; * matches any run, ? a single character. */
function matches(model, pattern) {
    const normalized = pattern.trim().toLowerCase();
    if (!/[?*]/.test(normalized))
        return model.toLowerCase().startsWith(normalized);
    const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i").test(model);
}
/** Resolve only the daemon's explicit default; never defer to engine/environment defaults. */
export function executionModel(value, backend, options, threadId) {
    const model = value == null || value === "default" ? options.defaultModel : value;
    if (typeof model !== "string" || !model.trim() || model.trim().toLowerCase() === "default") {
        throw new ProtocolError(ErrorCode.invalid_params, "an explicit execution model is required", {
            threadId, reason: "model_required",
            detail: { backend, hint: "Pass a nonempty model, inherit a saved explicit model on resume/fork, or configure daemon default_model. Engine/environment defaults are disabled." },
        });
    }
    const selected = model.trim();
    const denied = options.deniedModels ?? DEFAULT_DENIED_MODELS;
    const check = (candidate) => {
        const pattern = denied.find(pattern => matches(candidate, pattern));
        if (pattern !== undefined)
            throw new ProtocolError(ErrorCode.invalid_params, "execution model is denied", {
                threadId, reason: "model_denied",
                detail: { backend, model: selected, resolvedModel: candidate, pattern, hint: "Choose a model permitted by daemon denied_models." },
            });
    };
    check(selected);
    if (backend === "claude") {
        const resolved = resolveClaudeModel(selected).model;
        if (!resolved?.trim() || resolved.trim().toLowerCase() === "default") {
            throw new ProtocolError(ErrorCode.invalid_params, "model alias resolves to an engine default", { threadId, reason: "model_required", detail: { backend, hint: "Use an explicit model instead of an alias to the engine default." } });
        }
        check(resolved.trim());
    }
    return selected;
}
