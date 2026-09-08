import { z } from "zod";
export declare const NotificationSchemas: {
    readonly initialized: z.ZodObject<{}, z.core.$strip>;
    readonly "thread/started": z.ZodObject<{
        threadId: z.ZodString;
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
    readonly "thread/status/changed": z.ZodObject<{
        threadId: z.ZodString;
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
    }, z.core.$strip>;
    readonly "thread/queue/changed": z.ZodObject<{
        threadId: z.ZodString;
        queue: z.ZodArray<z.ZodObject<{
            turnId: z.ZodString;
            clientTurnId: z.ZodOptional<z.ZodString>;
            position: z.ZodNumber;
            enqueuedAtMs: z.ZodNumber;
            preview: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    readonly "thread/closed": z.ZodObject<{
        threadId: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>;
    readonly "thread/tokenUsage/updated": z.ZodObject<{
        threadId: z.ZodString;
        usage: z.ZodObject<{
            usd: z.ZodNullable<z.ZodNumber>;
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cachedTokens: z.ZodNumber;
            cacheCreation: z.ZodNumber;
            estimated: z.ZodBoolean;
            contextTokens: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    readonly "thread/metadata/updated": z.ZodObject<{
        threadId: z.ZodString;
        engineThreadId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        title: z.ZodOptional<z.ZodString>;
        meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    }, z.core.$strip>;
    readonly "turn/started": z.ZodObject<{
        threadId: z.ZodString;
        turnId: z.ZodString;
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
    }, z.core.$strip>;
    readonly "turn/completed": z.ZodObject<{
        threadId: z.ZodString;
        turnId: z.ZodString;
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
    }, z.core.$strip>;
    readonly "turn/plan/updated": z.ZodObject<{
        threadId: z.ZodString;
        turnId: z.ZodString;
        plan: z.ZodObject<{
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
    }, z.core.$strip>;
    readonly "turn/diff/updated": z.ZodObject<{
        threadId: z.ZodString;
        turnId: z.ZodString;
        diffStat: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strip>;
    readonly "item/started": z.ZodObject<{
        item: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        }, z.core.$strip>], "type">;
        seq: z.ZodNumber;
        startedAtMs: z.ZodNumber;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/completed": z.ZodObject<{
        item: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        }, z.core.$strip>], "type">;
        seq: z.ZodNumber;
        completedAtMs: z.ZodNumber;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/agentMessage/delta": z.ZodObject<{
        delta: z.ZodString;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/reasoning/textDelta": z.ZodObject<{
        delta: z.ZodString;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/reasoning/summaryTextDelta": z.ZodObject<{
        delta: z.ZodString;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/commandExecution/outputDelta": z.ZodObject<{
        chunk: z.ZodString;
        stream: z.ZodEnum<{
            stderr: "stderr";
            stdout: "stdout";
        }>;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/fileChange/patchUpdated": z.ZodObject<{
        changes: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            kind: z.ZodEnum<{
                add: "add";
                update: "update";
                delete: "delete";
            }>;
            diff: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "item/subAgent/progress": z.ZodObject<{
        phase: z.ZodString;
        progress: z.ZodOptional<z.ZodJSONSchema>;
        threadId: z.ZodString;
        turnId: z.ZodString;
        itemId: z.ZodString;
    }, z.core.$strip>;
    readonly "serverRequest/resolved": z.ZodObject<{
        threadId: z.ZodString;
        requestId: z.ZodString;
        decidedBy: z.ZodObject<{
            clientId: z.ZodString;
            label: z.ZodString;
        }, z.core.$strip>;
        outcome: z.ZodJSONSchema;
    }, z.core.$strip>;
    readonly "serverRequest/expired": z.ZodObject<{
        threadId: z.ZodString;
        requestId: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>;
    readonly error: z.ZodObject<{
        threadId: z.ZodOptional<z.ZodString>;
        turnId: z.ZodOptional<z.ZodString>;
        error: z.ZodObject<{
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
        }, z.core.$strip>;
        willRetry: z.ZodBoolean;
    }, z.core.$strip>;
    readonly "server/shuttingDown": z.ZodObject<{
        reason: z.ZodString;
        graceMs: z.ZodNumber;
    }, z.core.$strip>;
};
export declare const NotificationMethodSchema: z.ZodEnum<{
    error: "error";
    initialized: "initialized";
    "thread/started": "thread/started";
    "thread/status/changed": "thread/status/changed";
    "thread/queue/changed": "thread/queue/changed";
    "thread/closed": "thread/closed";
    "thread/tokenUsage/updated": "thread/tokenUsage/updated";
    "thread/metadata/updated": "thread/metadata/updated";
    "turn/started": "turn/started";
    "turn/completed": "turn/completed";
    "turn/plan/updated": "turn/plan/updated";
    "turn/diff/updated": "turn/diff/updated";
    "item/started": "item/started";
    "item/completed": "item/completed";
    "item/agentMessage/delta": "item/agentMessage/delta";
    "item/reasoning/textDelta": "item/reasoning/textDelta";
    "item/reasoning/summaryTextDelta": "item/reasoning/summaryTextDelta";
    "item/commandExecution/outputDelta": "item/commandExecution/outputDelta";
    "item/fileChange/patchUpdated": "item/fileChange/patchUpdated";
    "item/subAgent/progress": "item/subAgent/progress";
    "serverRequest/resolved": "serverRequest/resolved";
    "serverRequest/expired": "serverRequest/expired";
    "server/shuttingDown": "server/shuttingDown";
}>;
export type NotificationMethod = z.infer<typeof NotificationMethodSchema>;
export type NotificationParams<M extends NotificationMethod> = z.infer<(typeof NotificationSchemas)[M]>;
export type ServerNotification = {
    [M in NotificationMethod]: {
        jsonrpc: "2.0";
        method: M;
        params: NotificationParams<M>;
    };
}[NotificationMethod];
