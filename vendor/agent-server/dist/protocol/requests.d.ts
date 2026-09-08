import { z } from "zod";
export declare const PendingRequestStateSchema: z.ZodObject<{
    threadId: z.ZodString;
    turnId: z.ZodString;
    requestId: z.ZodString;
    itemId: z.ZodString;
    kind: z.ZodEnum<{
        commandExecution: "commandExecution";
        fileChange: "fileChange";
        permissions: "permissions";
        userInput: "userInput";
    }>;
    status: z.ZodEnum<{
        pending: "pending";
        resolved: "resolved";
        expired: "expired";
    }>;
    decidedBy: z.ZodNullable<z.ZodObject<{
        clientId: z.ZodString;
        label: z.ZodString;
    }, z.core.$strip>>;
    createdAtMs: z.ZodNumber;
    updatedAtMs: z.ZodNumber;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type PendingRequestState = z.infer<typeof PendingRequestStateSchema>;
export declare const ApprovalDecisionSchema: z.ZodEnum<{
    abort: "abort";
    accept: "accept";
    acceptForSession: "acceptForSession";
    reject: "reject";
}>;
export declare const GrantedPermissionsSchema: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
export declare const QuestionSchema: z.ZodObject<{
    id: z.ZodString;
    question: z.ZodString;
    header: z.ZodOptional<z.ZodString>;
    multiSelect: z.ZodOptional<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const AnswerSchema: z.ZodObject<{
    answers: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const ServerRequestSchemas: {
    readonly "item/commandExecution/requestApproval": {
        readonly params: z.ZodObject<{
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
        readonly result: z.ZodObject<{
            decision: z.ZodEnum<{
                abort: "abort";
                accept: "accept";
                acceptForSession: "acceptForSession";
                reject: "reject";
            }>;
        }, z.core.$strip>;
    };
    readonly "item/fileChange/requestApproval": {
        readonly params: z.ZodObject<{
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
        readonly result: z.ZodObject<{
            decision: z.ZodEnum<{
                abort: "abort";
                accept: "accept";
                acceptForSession: "acceptForSession";
                reject: "reject";
            }>;
        }, z.core.$strip>;
    };
    readonly "item/permissions/requestApproval": {
        readonly params: z.ZodObject<{
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
        readonly result: z.ZodObject<{
            permissions: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
            scope: z.ZodEnum<{
                turn: "turn";
                thread: "thread";
                session: "session";
            }>;
        }, z.core.$strip>;
    };
    readonly "item/tool/requestUserInput": {
        readonly params: z.ZodObject<{
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
        readonly result: z.ZodObject<{
            answers: z.ZodRecord<z.ZodString, z.ZodObject<{
                answers: z.ZodArray<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    };
};
export declare const ServerRequestMethodSchema: z.ZodEnum<{
    "item/commandExecution/requestApproval": "item/commandExecution/requestApproval";
    "item/fileChange/requestApproval": "item/fileChange/requestApproval";
    "item/permissions/requestApproval": "item/permissions/requestApproval";
    "item/tool/requestUserInput": "item/tool/requestUserInput";
}>;
export declare const PendingServerRequestSchema: z.ZodIntersection<z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strip>], "method">, z.ZodObject<{
    state: z.ZodOptional<z.ZodObject<{
        threadId: z.ZodString;
        turnId: z.ZodString;
        requestId: z.ZodString;
        itemId: z.ZodString;
        kind: z.ZodEnum<{
            commandExecution: "commandExecution";
            fileChange: "fileChange";
            permissions: "permissions";
            userInput: "userInput";
        }>;
        status: z.ZodEnum<{
            pending: "pending";
            resolved: "resolved";
            expired: "expired";
        }>;
        decidedBy: z.ZodNullable<z.ZodObject<{
            clientId: z.ZodString;
            label: z.ZodString;
        }, z.core.$strip>>;
        createdAtMs: z.ZodNumber;
        updatedAtMs: z.ZodNumber;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>>;
export type ServerRequestMethod = z.infer<typeof ServerRequestMethodSchema>;
export type PendingServerRequest = z.infer<typeof PendingServerRequestSchema>;
export type ServerRequestParams<M extends ServerRequestMethod> = z.infer<(typeof ServerRequestSchemas)[M]["params"]>;
export type ServerRequestResult<M extends ServerRequestMethod = ServerRequestMethod> = z.infer<(typeof ServerRequestSchemas)[M]["result"]>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type GrantedPermissions = z.infer<typeof GrantedPermissionsSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export declare function pendingRequestState(request: PendingServerRequest, createdAtMs: number): PendingRequestState;
