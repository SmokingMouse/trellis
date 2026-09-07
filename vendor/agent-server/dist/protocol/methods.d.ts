import { z } from "zod";
export declare const ThreadOptionsSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    permission: z.ZodOptional<z.ZodEnum<{
        default: "default";
        readonly: "readonly";
        "auto-edit": "auto-edit";
        full: "full";
    }>>;
    sandbox: z.ZodOptional<z.ZodString>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
}, z.core.$strict>;
export declare const StartThreadParamsSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    permission: z.ZodOptional<z.ZodEnum<{
        default: "default";
        readonly: "readonly";
        "auto-edit": "auto-edit";
        full: "full";
    }>>;
    sandbox: z.ZodOptional<z.ZodString>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    backend: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        external: "external";
    }>;
    clientThreadId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const StartTurnParamsSchema: z.ZodObject<{
    threadId: z.ZodString;
    input: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    permission: z.ZodOptional<z.ZodEnum<{
        default: "default";
        readonly: "readonly";
        "auto-edit": "auto-edit";
        full: "full";
    }>>;
    sandbox: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const AttachResultSchema: z.ZodObject<{
    thread: z.ZodObject<{
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
                code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
        createdAtMs: z.ZodNumber;
        closedAtMs: z.ZodOptional<z.ZodNumber>;
        clientThreadId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    items: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"userMessage">;
        payload: z.ZodObject<{
            content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                agent: "agent";
                bash: "bash";
                workflow: "workflow";
            }>;
            parentItemId: z.ZodString;
            phase: z.ZodString;
            progress: z.ZodOptional<z.ZodJSONSchema>;
            report: z.ZodOptional<z.ZodJSONSchema>;
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
    }, z.core.$strip>], "type">>;
    nextSeq: z.ZodNumber;
    queue: z.ZodArray<z.ZodObject<{
        turnId: z.ZodString;
        clientTurnId: z.ZodOptional<z.ZodString>;
        position: z.ZodNumber;
        enqueuedAtMs: z.ZodNumber;
        preview: z.ZodString;
    }, z.core.$strip>>;
    pendingRequests: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        method: z.ZodLiteral<"item/commandExecution/requestApproval">;
        params: z.ZodObject<{
            command: z.ZodString;
            cwd: z.ZodString;
            reason: z.ZodOptional<z.ZodString>;
            startedAtMs: z.ZodNumber;
            requestId: z.ZodString;
            threadId: z.ZodString;
            turnId: z.ZodString;
            itemId: z.ZodString;
            data: z.ZodOptional<z.ZodObject<{
                raw: z.ZodJSONSchema;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        method: z.ZodLiteral<"item/fileChange/requestApproval">;
        params: z.ZodObject<{
            changes: z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                kind: z.ZodEnum<{
                    add: "add";
                    update: "update";
                    delete: "delete";
                }>;
                diff: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            grantRoot: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            startedAtMs: z.ZodNumber;
            requestId: z.ZodString;
            threadId: z.ZodString;
            turnId: z.ZodString;
            itemId: z.ZodString;
            data: z.ZodOptional<z.ZodObject<{
                raw: z.ZodJSONSchema;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        method: z.ZodLiteral<"item/permissions/requestApproval">;
        params: z.ZodObject<{
            cwd: z.ZodString;
            permissions: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
            reason: z.ZodOptional<z.ZodString>;
            startedAtMs: z.ZodNumber;
            requestId: z.ZodString;
            threadId: z.ZodString;
            turnId: z.ZodString;
            itemId: z.ZodString;
            data: z.ZodOptional<z.ZodObject<{
                raw: z.ZodJSONSchema;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        method: z.ZodLiteral<"item/tool/requestUserInput">;
        params: z.ZodObject<{
            questions: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                question: z.ZodString;
                header: z.ZodOptional<z.ZodString>;
                multiSelect: z.ZodOptional<z.ZodBoolean>;
                options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>>;
            }, z.core.$strip>>;
            isBlocking: z.ZodBoolean;
            requestId: z.ZodString;
            threadId: z.ZodString;
            turnId: z.ZodString;
            itemId: z.ZodString;
            data: z.ZodOptional<z.ZodObject<{
                raw: z.ZodJSONSchema;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>], "method">>;
}, z.core.$strip>;
export declare const ResumeThreadParamsSchema: z.ZodUnion<readonly [z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    permission: z.ZodOptional<z.ZodEnum<{
        default: "default";
        readonly: "readonly";
        "auto-edit": "auto-edit";
        full: "full";
    }>>;
    sandbox: z.ZodOptional<z.ZodString>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    engineThreadId: z.ZodOptional<z.ZodString>;
    backend: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        external: "external";
    }>>;
    threadId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    permission: z.ZodOptional<z.ZodEnum<{
        default: "default";
        readonly: "readonly";
        "auto-edit": "auto-edit";
        full: "full";
    }>>;
    sandbox: z.ZodOptional<z.ZodString>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
    meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    threadId: z.ZodOptional<z.ZodString>;
    backend: z.ZodOptional<z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        external: "external";
    }>>;
    engineThreadId: z.ZodString;
}, z.core.$strict>]>;
export declare const MethodSchemas: {
    readonly initialize: {
        readonly params: z.ZodObject<{
            protocolVersion: z.ZodString;
            token: z.ZodOptional<z.ZodString>;
            client: z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
                kind: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>;
            capabilities: z.ZodOptional<z.ZodObject<{
                serverRequests: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                    "item/commandExecution/requestApproval": "item/commandExecution/requestApproval";
                    "item/fileChange/requestApproval": "item/fileChange/requestApproval";
                    "item/permissions/requestApproval": "item/permissions/requestApproval";
                    "item/tool/requestUserInput": "item/tool/requestUserInput";
                }>>>;
                notifications: z.ZodOptional<z.ZodObject<{
                    optOut: z.ZodArray<z.ZodString>;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            protocolVersion: z.ZodLiteral<"as/1">;
            server: z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strip>;
            clientId: z.ZodString;
            capabilities: z.ZodObject<{
                backends: z.ZodArray<z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    external: "external";
                }>>;
                steer: z.ZodBoolean;
                fork: z.ZodBoolean;
                leases: z.ZodBoolean;
                externalProviders: z.ZodBoolean;
                maxQueuedTurns: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    };
    readonly "thread/start": {
        readonly params: z.ZodObject<{
            cwd: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            effort: z.ZodOptional<z.ZodString>;
            permission: z.ZodOptional<z.ZodEnum<{
                default: "default";
                readonly: "readonly";
                "auto-edit": "auto-edit";
                full: "full";
            }>>;
            sandbox: z.ZodOptional<z.ZodString>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
            meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
            backend: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                external: "external";
            }>;
            clientThreadId: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            thread: z.ZodObject<{
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
                        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
                createdAtMs: z.ZodNumber;
                closedAtMs: z.ZodOptional<z.ZodNumber>;
                clientThreadId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            deduplicated: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strip>;
    };
    readonly "thread/resume": {
        readonly params: z.ZodUnion<readonly [z.ZodObject<{
            cwd: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            effort: z.ZodOptional<z.ZodString>;
            permission: z.ZodOptional<z.ZodEnum<{
                default: "default";
                readonly: "readonly";
                "auto-edit": "auto-edit";
                full: "full";
            }>>;
            sandbox: z.ZodOptional<z.ZodString>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
            meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
            engineThreadId: z.ZodOptional<z.ZodString>;
            backend: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                external: "external";
            }>>;
            threadId: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            cwd: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            effort: z.ZodOptional<z.ZodString>;
            permission: z.ZodOptional<z.ZodEnum<{
                default: "default";
                readonly: "readonly";
                "auto-edit": "auto-edit";
                full: "full";
            }>>;
            sandbox: z.ZodOptional<z.ZodString>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            tools: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"all">, z.ZodArray<z.ZodString>]>>;
            meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
            threadId: z.ZodOptional<z.ZodString>;
            backend: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                external: "external";
            }>>;
            engineThreadId: z.ZodString;
        }, z.core.$strict>]>;
        readonly result: z.ZodObject<{
            thread: z.ZodObject<{
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
                        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
                createdAtMs: z.ZodNumber;
                closedAtMs: z.ZodOptional<z.ZodNumber>;
                clientThreadId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            deduplicated: z.ZodOptional<z.ZodLiteral<true>>;
            attached: z.ZodBoolean;
        }, z.core.$strip>;
    };
    readonly "thread/attach": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            sinceSeq: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        readonly result: z.ZodObject<{
            thread: z.ZodObject<{
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
                        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
                createdAtMs: z.ZodNumber;
                closedAtMs: z.ZodOptional<z.ZodNumber>;
                clientThreadId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            items: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"userMessage">;
                payload: z.ZodObject<{
                    content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        agent: "agent";
                        bash: "bash";
                        workflow: "workflow";
                    }>;
                    parentItemId: z.ZodString;
                    phase: z.ZodString;
                    progress: z.ZodOptional<z.ZodJSONSchema>;
                    report: z.ZodOptional<z.ZodJSONSchema>;
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
            }, z.core.$strip>], "type">>;
            nextSeq: z.ZodNumber;
            queue: z.ZodArray<z.ZodObject<{
                turnId: z.ZodString;
                clientTurnId: z.ZodOptional<z.ZodString>;
                position: z.ZodNumber;
                enqueuedAtMs: z.ZodNumber;
                preview: z.ZodString;
            }, z.core.$strip>>;
            pendingRequests: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                method: z.ZodLiteral<"item/commandExecution/requestApproval">;
                params: z.ZodObject<{
                    command: z.ZodString;
                    cwd: z.ZodString;
                    reason: z.ZodOptional<z.ZodString>;
                    startedAtMs: z.ZodNumber;
                    requestId: z.ZodString;
                    threadId: z.ZodString;
                    turnId: z.ZodString;
                    itemId: z.ZodString;
                    data: z.ZodOptional<z.ZodObject<{
                        raw: z.ZodJSONSchema;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                method: z.ZodLiteral<"item/fileChange/requestApproval">;
                params: z.ZodObject<{
                    changes: z.ZodArray<z.ZodObject<{
                        path: z.ZodString;
                        kind: z.ZodEnum<{
                            add: "add";
                            update: "update";
                            delete: "delete";
                        }>;
                        diff: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>>;
                    grantRoot: z.ZodOptional<z.ZodString>;
                    reason: z.ZodOptional<z.ZodString>;
                    startedAtMs: z.ZodNumber;
                    requestId: z.ZodString;
                    threadId: z.ZodString;
                    turnId: z.ZodString;
                    itemId: z.ZodString;
                    data: z.ZodOptional<z.ZodObject<{
                        raw: z.ZodJSONSchema;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                method: z.ZodLiteral<"item/permissions/requestApproval">;
                params: z.ZodObject<{
                    cwd: z.ZodString;
                    permissions: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
                    reason: z.ZodOptional<z.ZodString>;
                    startedAtMs: z.ZodNumber;
                    requestId: z.ZodString;
                    threadId: z.ZodString;
                    turnId: z.ZodString;
                    itemId: z.ZodString;
                    data: z.ZodOptional<z.ZodObject<{
                        raw: z.ZodJSONSchema;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                method: z.ZodLiteral<"item/tool/requestUserInput">;
                params: z.ZodObject<{
                    questions: z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        question: z.ZodString;
                        header: z.ZodOptional<z.ZodString>;
                        multiSelect: z.ZodOptional<z.ZodBoolean>;
                        options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                            label: z.ZodString;
                            description: z.ZodOptional<z.ZodString>;
                        }, z.core.$strip>>>;
                    }, z.core.$strip>>;
                    isBlocking: z.ZodBoolean;
                    requestId: z.ZodString;
                    threadId: z.ZodString;
                    turnId: z.ZodString;
                    itemId: z.ZodString;
                    data: z.ZodOptional<z.ZodObject<{
                        raw: z.ZodJSONSchema;
                    }, z.core.$strip>>;
                }, z.core.$strip>;
            }, z.core.$strip>], "method">>;
        }, z.core.$strip>;
    };
    readonly "thread/detach": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{}, z.core.$strip>;
    };
    readonly "thread/items/list": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            cursor: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
            turnId: z.ZodOptional<z.ZodString>;
            direction: z.ZodOptional<z.ZodEnum<{
                asc: "asc";
                desc: "desc";
            }>>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            items: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"userMessage">;
                payload: z.ZodObject<{
                    content: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        agent: "agent";
                        bash: "bash";
                        workflow: "workflow";
                    }>;
                    parentItemId: z.ZodString;
                    phase: z.ZodString;
                    progress: z.ZodOptional<z.ZodJSONSchema>;
                    report: z.ZodOptional<z.ZodJSONSchema>;
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
            }, z.core.$strip>], "type">>;
            nextCursor: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    };
    readonly "thread/list": {
        readonly params: z.ZodObject<{
            status: z.ZodOptional<z.ZodEnum<{
                spawning: "spawning";
                idle: "idle";
                running: "running";
                interrupted: "interrupted";
                systemError: "systemError";
                closed: "closed";
            }>>;
            backend: z.ZodOptional<z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                external: "external";
            }>>;
            cwd: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
            cursor: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            threads: z.ZodArray<z.ZodObject<{
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
                        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
                createdAtMs: z.ZodNumber;
                closedAtMs: z.ZodOptional<z.ZodNumber>;
                clientThreadId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            nextCursor: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    };
    readonly "thread/read": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            thread: z.ZodObject<{
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
                        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
                createdAtMs: z.ZodNumber;
                closedAtMs: z.ZodOptional<z.ZodNumber>;
                clientThreadId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
        }, z.core.$strip>;
    };
    readonly "thread/fork": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            fromItemId: z.ZodOptional<z.ZodString>;
            clientThreadId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            thread: z.ZodObject<{
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
                        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
                createdAtMs: z.ZodNumber;
                closedAtMs: z.ZodOptional<z.ZodNumber>;
                clientThreadId: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>;
            deduplicated: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strip>;
    };
    readonly "thread/close": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{}, z.core.$strip>;
    };
    readonly "thread/interrupt": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            interruptedTurnId: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
    };
    readonly "thread/lease/acquire": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            ttlMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            lease: z.ZodObject<{
                threadId: z.ZodString;
                holder: z.ZodObject<{
                    clientId: z.ZodString;
                    label: z.ZodString;
                }, z.core.$strip>;
                expiresAtMs: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    };
    readonly "thread/lease/release": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{}, z.core.$strip>;
    };
    readonly "turn/start": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            input: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
            model: z.ZodOptional<z.ZodString>;
            effort: z.ZodOptional<z.ZodString>;
            cwd: z.ZodOptional<z.ZodString>;
            permission: z.ZodOptional<z.ZodEnum<{
                default: "default";
                readonly: "readonly";
                "auto-edit": "auto-edit";
                full: "full";
            }>>;
            sandbox: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            turn: z.ZodObject<{
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
                    code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
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
            deduplicated: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strip>;
    };
    readonly "turn/steer": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            expectedTurnId: z.ZodString;
            input: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        readonly result: z.ZodObject<{}, z.core.$strip>;
    };
    readonly "turn/interrupt": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            turnId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{}, z.core.$strip>;
    };
    readonly "turn/cancel": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
            turnId: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{}, z.core.$strip>;
    };
    readonly "thread/queue/read": {
        readonly params: z.ZodObject<{
            threadId: z.ZodString;
        }, z.core.$strip>;
        readonly result: z.ZodObject<{
            queue: z.ZodArray<z.ZodObject<{
                turnId: z.ZodString;
                clientTurnId: z.ZodOptional<z.ZodString>;
                position: z.ZodNumber;
                enqueuedAtMs: z.ZodNumber;
                preview: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
    readonly "server/health": {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            uptimeMs: z.ZodNumber;
            threads: z.ZodObject<{
                running: z.ZodNumber;
                idle: z.ZodNumber;
                closed: z.ZodNumber;
            }, z.core.$strip>;
            engines: z.ZodArray<z.ZodObject<{
                threadId: z.ZodString;
                backend: z.ZodEnum<{
                    claude: "claude";
                    codex: "codex";
                    external: "external";
                }>;
                engineThreadId: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
    readonly "server/config/read": {
        readonly params: z.ZodObject<{}, z.core.$strip>;
        readonly result: z.ZodObject<{
            allowed_roots: z.ZodArray<z.ZodString>;
            maxQueuedTurns: z.ZodNumber;
            orphanTimeoutMs: z.ZodNumber;
            idleTimeoutMs: z.ZodNumber;
        }, z.core.$strip>;
    };
};
export declare const MethodSchema: z.ZodEnum<{
    initialize: "initialize";
    "thread/start": "thread/start";
    "thread/resume": "thread/resume";
    "thread/attach": "thread/attach";
    "thread/detach": "thread/detach";
    "thread/items/list": "thread/items/list";
    "thread/list": "thread/list";
    "thread/read": "thread/read";
    "thread/fork": "thread/fork";
    "thread/close": "thread/close";
    "thread/interrupt": "thread/interrupt";
    "thread/lease/acquire": "thread/lease/acquire";
    "thread/lease/release": "thread/lease/release";
    "turn/start": "turn/start";
    "turn/steer": "turn/steer";
    "turn/interrupt": "turn/interrupt";
    "turn/cancel": "turn/cancel";
    "thread/queue/read": "thread/queue/read";
    "server/health": "server/health";
    "server/config/read": "server/config/read";
}>;
export type Method = z.infer<typeof MethodSchema>;
export type MethodParams<M extends Method> = z.infer<(typeof MethodSchemas)[M]["params"]>;
export type MethodResult<M extends Method> = z.infer<(typeof MethodSchemas)[M]["result"]>;
export type StartThreadParams = z.infer<typeof StartThreadParamsSchema>;
export type StartTurnParams = z.infer<typeof StartTurnParamsSchema>;
export type AttachResult = z.infer<typeof AttachResultSchema>;
//# sourceMappingURL=methods.d.ts.map