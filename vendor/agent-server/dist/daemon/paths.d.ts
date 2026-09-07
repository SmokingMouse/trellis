export interface DaemonPaths {
    socketPath: string;
    socketSource: string;
    pidPath: string;
    tokenPath: string;
    logPath: string;
    databasePath: string;
    configPath: string;
    endpointPath: string;
}
export declare function resolveDaemonPaths(env?: NodeJS.ProcessEnv): DaemonPaths;
export declare function ensureParent(path: string): void;
export declare function loadToken(path: string, create?: boolean): string;
//# sourceMappingURL=paths.d.ts.map