import { z } from "zod";
export declare const IdSchema: z.ZodString;
export declare const TimestampSchema: z.ZodNumber;
export declare const JsonObjectSchema: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
export declare const AbsolutePathSchema: z.ZodString;
export declare const BackendSchema: z.ZodEnum<{
    claude: "claude";
    codex: "codex";
    external: "external";
}>;
export declare const ClaudeEffortSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
    xhigh: "xhigh";
    max: "max";
}>;
export declare const PermissionSchema: z.ZodEnum<{
    default: "default";
    readonly: "readonly";
    "auto-edit": "auto-edit";
    full: "full";
    acceptEdits: "acceptEdits";
    plan: "plan";
    bypassPermissions: "bypassPermissions";
    dontAsk: "dontAsk";
}>;
export declare const UserInputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"bash">;
    command: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    path: z.ZodString;
    mime: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"file">;
    path: z.ZodString;
    mime: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "type">;
export declare const UsageSchema: z.ZodObject<{
    usd: z.ZodNullable<z.ZodNumber>;
    inputTokens: z.ZodNumber;
    outputTokens: z.ZodNumber;
    cachedTokens: z.ZodNumber;
    cacheCreation: z.ZodNumber;
    estimated: z.ZodBoolean;
    contextTokens: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ThreadStatusTypeSchema: z.ZodEnum<{
    spawning: "spawning";
    idle: "idle";
    running: "running";
    interrupted: "interrupted";
    systemError: "systemError";
    closed: "closed";
}>;
export declare const ThreadStatusSchema: z.ZodObject<{
    type: z.ZodEnum<{
        spawning: "spawning";
        idle: "idle";
        running: "running";
        interrupted: "interrupted";
        systemError: "systemError";
        closed: "closed";
    }>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015 | -32016>[]>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodObject<{
            threadId: z.ZodOptional<z.ZodString>;
            turnId: z.ZodOptional<z.ZodString>;
            itemId: z.ZodOptional<z.ZodString>;
            retryable: z.ZodBoolean;
            detail: z.ZodOptional<z.ZodJSONSchema>;
            stderr: z.ZodOptional<z.ZodString>;
            raw: z.ZodOptional<z.ZodJSONSchema>;
            holder: z.ZodOptional<z.ZodObject<{
                clientId: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ThreadSchema: z.ZodObject<{
    id: z.ZodString;
    backend: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        external: "external";
    }>;
    engineThreadId: z.ZodNullable<z.ZodString>;
    status: z.ZodObject<{
        type: z.ZodEnum<{
            spawning: "spawning";
            idle: "idle";
            running: "running";
            interrupted: "interrupted";
            systemError: "systemError";
            closed: "closed";
        }>;
        error: z.ZodOptional<z.ZodObject<{
            code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015 | -32016>[]>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodObject<{
                threadId: z.ZodOptional<z.ZodString>;
                turnId: z.ZodOptional<z.ZodString>;
                itemId: z.ZodOptional<z.ZodString>;
                retryable: z.ZodBoolean;
                detail: z.ZodOptional<z.ZodJSONSchema>;
                stderr: z.ZodOptional<z.ZodString>;
                raw: z.ZodOptional<z.ZodJSONSchema>;
                holder: z.ZodOptional<z.ZodObject<{
                    clientId: z.ZodString;
                    label: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    cwd: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    permission: z.ZodOptional<z.ZodEnum<{
        default: "default";
        readonly: "readonly";
        "auto-edit": "auto-edit";
        full: "full";
        acceptEdits: "acceptEdits";
        plan: "plan";
        bypassPermissions: "bypassPermissions";
        dontAsk: "dontAsk";
    }>>;
    createdAtMs: z.ZodNumber;
    closedAtMs: z.ZodOptional<z.ZodNumber>;
    clientThreadId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const TurnSchema: z.ZodObject<{
    id: z.ZodString;
    threadId: z.ZodString;
    ordinal: z.ZodNumber;
    status: z.ZodEnum<{
        interrupted: "interrupted";
        queued: "queued";
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    clientTurnId: z.ZodOptional<z.ZodString>;
    enqueuedAtMs: z.ZodNumber;
    startedAtMs: z.ZodOptional<z.ZodNumber>;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    usage: z.ZodOptional<z.ZodObject<{
        usd: z.ZodNullable<z.ZodNumber>;
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cachedTokens: z.ZodNumber;
        cacheCreation: z.ZodNumber;
        estimated: z.ZodBoolean;
        contextTokens: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015 | -32016>[]>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodObject<{
            threadId: z.ZodOptional<z.ZodString>;
            turnId: z.ZodOptional<z.ZodString>;
            itemId: z.ZodOptional<z.ZodString>;
            retryable: z.ZodBoolean;
            detail: z.ZodOptional<z.ZodJSONSchema>;
            stderr: z.ZodOptional<z.ZodString>;
            raw: z.ZodOptional<z.ZodJSONSchema>;
            holder: z.ZodOptional<z.ZodObject<{
                clientId: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const QueuedTurnSchema: z.ZodObject<{
    turnId: z.ZodString;
    clientTurnId: z.ZodOptional<z.ZodString>;
    position: z.ZodNumber;
    enqueuedAtMs: z.ZodNumber;
    preview: z.ZodString;
}, z.core.$strip>;
export declare const ClientIdentitySchema: z.ZodObject<{
    clientId: z.ZodString;
    label: z.ZodString;
}, z.core.$strip>;
export declare const LeaseSchema: z.ZodObject<{
    threadId: z.ZodString;
    holder: z.ZodObject<{
        clientId: z.ZodString;
        label: z.ZodString;
    }, z.core.$strip>;
    expiresAtMs: z.ZodNumber;
}, z.core.$strip>;
export declare const FileChangesSchema: z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    kind: z.ZodEnum<{
        add: "add";
        update: "update";
        delete: "delete";
    }>;
    diff: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export declare const PlanStepSchema: z.ZodObject<{
    step: z.ZodString;
    status: z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        pending: "pending";
    }>;
}, z.core.$strip>;
export declare const PlanSchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodString>;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        step: z.ZodString;
        status: z.ZodEnum<{
            inProgress: "inProgress";
            completed: "completed";
            pending: "pending";
        }>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const ItemPayloadSchemas: {
    readonly userMessage: z.ZodObject<{
        content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"bash">;
            command: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            path: z.ZodString;
            mime: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"file">;
            path: z.ZodString;
            mime: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>], "type">>;
        clientTurnId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly agentMessage: z.ZodObject<{
        text: z.ZodString;
        phase: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly reasoning: z.ZodObject<{
        summary: z.ZodOptional<z.ZodString>;
        text: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly commandExecution: z.ZodObject<{
        command: z.ZodString;
        cwd: z.ZodString;
        exitCode: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        aggregatedOutput: z.ZodOptional<z.ZodString>;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    readonly fileChange: z.ZodObject<{
        changes: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            kind: z.ZodEnum<{
                add: "add";
                update: "update";
                delete: "delete";
            }>;
            diff: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        status: z.ZodEnum<{
            inProgress: "inProgress";
            completed: "completed";
            failed: "failed";
            rejected: "rejected";
        }>;
    }, z.core.$strip>;
    readonly toolCall: z.ZodObject<{
        name: z.ZodString;
        namespace: z.ZodOptional<z.ZodString>;
        input: z.ZodJSONSchema;
        output: z.ZodOptional<z.ZodJSONSchema>;
        isError: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    readonly mcpToolCall: z.ZodObject<{
        server: z.ZodString;
        tool: z.ZodString;
        arguments: z.ZodJSONSchema;
        result: z.ZodOptional<z.ZodJSONSchema>;
        error: z.ZodOptional<z.ZodJSONSchema>;
    }, z.core.$strip>;
    readonly subAgent: z.ZodObject<{
        kind: z.ZodEnum<{
            bash: "bash";
            agent: "agent";
            workflow: "workflow";
        }>;
        parentItemId: z.ZodString;
        phase: z.ZodString;
        progress: z.ZodOptional<z.ZodJSONSchema>;
        report: z.ZodOptional<z.ZodJSONSchema>;
        text: z.ZodOptional<z.ZodString>;
        thinking: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly webSearch: z.ZodObject<{
        query: z.ZodString;
        results: z.ZodOptional<z.ZodJSONSchema>;
    }, z.core.$strip>;
    readonly imageOutput: z.ZodObject<{
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    readonly plan: z.ZodObject<{
        text: z.ZodOptional<z.ZodString>;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            step: z.ZodString;
            status: z.ZodEnum<{
                inProgress: "inProgress";
                completed: "completed";
                pending: "pending";
            }>;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
    readonly contextCompaction: z.ZodObject<{}, z.core.$strip>;
    readonly error: z.ZodObject<{
        message: z.ZodString;
        code: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
        retryable: z.ZodBoolean;
    }, z.core.$strip>;
};
export declare const ItemTypeSchema: z.ZodEnum<{
    error: "error";
    plan: "plan";
    userMessage: "userMessage";
    agentMessage: "agentMessage";
    reasoning: "reasoning";
    commandExecution: "commandExecution";
    fileChange: "fileChange";
    toolCall: "toolCall";
    mcpToolCall: "mcpToolCall";
    subAgent: "subAgent";
    webSearch: "webSearch";
    imageOutput: "imageOutput";
    contextCompaction: "contextCompaction";
}>;
export declare const ItemSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"userMessage">;
    payload: z.ZodObject<{
        content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"bash">;
            command: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            path: z.ZodString;
            mime: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"file">;
            path: z.ZodString;
            mime: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>], "type">>;
        clientTurnId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"agentMessage">;
    payload: z.ZodObject<{
        text: z.ZodString;
        phase: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    payload: z.ZodObject<{
        summary: z.ZodOptional<z.ZodString>;
        text: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"commandExecution">;
    payload: z.ZodObject<{
        command: z.ZodString;
        cwd: z.ZodString;
        exitCode: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        aggregatedOutput: z.ZodOptional<z.ZodString>;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"fileChange">;
    payload: z.ZodObject<{
        changes: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            kind: z.ZodEnum<{
                add: "add";
                update: "update";
                delete: "delete";
            }>;
            diff: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        status: z.ZodEnum<{
            inProgress: "inProgress";
            completed: "completed";
            failed: "failed";
            rejected: "rejected";
        }>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"toolCall">;
    payload: z.ZodObject<{
        name: z.ZodString;
        namespace: z.ZodOptional<z.ZodString>;
        input: z.ZodJSONSchema;
        output: z.ZodOptional<z.ZodJSONSchema>;
        isError: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"mcpToolCall">;
    payload: z.ZodObject<{
        server: z.ZodString;
        tool: z.ZodString;
        arguments: z.ZodJSONSchema;
        result: z.ZodOptional<z.ZodJSONSchema>;
        error: z.ZodOptional<z.ZodJSONSchema>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"subAgent">;
    payload: z.ZodObject<{
        kind: z.ZodEnum<{
            bash: "bash";
            agent: "agent";
            workflow: "workflow";
        }>;
        parentItemId: z.ZodString;
        phase: z.ZodString;
        progress: z.ZodOptional<z.ZodJSONSchema>;
        report: z.ZodOptional<z.ZodJSONSchema>;
        text: z.ZodOptional<z.ZodString>;
        thinking: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"webSearch">;
    payload: z.ZodObject<{
        query: z.ZodString;
        results: z.ZodOptional<z.ZodJSONSchema>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"imageOutput">;
    payload: z.ZodObject<{
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"plan">;
    payload: z.ZodObject<{
        text: z.ZodOptional<z.ZodString>;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            step: z.ZodString;
            status: z.ZodEnum<{
                inProgress: "inProgress";
                completed: "completed";
                pending: "pending";
            }>;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"contextCompaction">;
    payload: z.ZodObject<{}, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    payload: z.ZodObject<{
        message: z.ZodString;
        code: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
        retryable: z.ZodBoolean;
    }, z.core.$strip>;
    id: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        inProgress: "inProgress";
        completed: "completed";
        failed: "failed";
        rejected: "rejected";
    }>>;
    seq: z.ZodNumber;
    completedSeq: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodString;
    startedAtMs: z.ZodNumber;
    completedAtMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>], "type">;
export type Backend = z.infer<typeof BackendSchema>;
export type UserInput = z.infer<typeof UserInputSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type QueuedTurn = z.infer<typeof QueuedTurnSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type ItemType = z.infer<typeof ItemTypeSchema>;
export type ClientIdentity = z.infer<typeof ClientIdentitySchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
