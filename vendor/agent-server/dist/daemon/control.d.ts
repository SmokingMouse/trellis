import type { MethodResult } from "../protocol/index.js";
import { type DaemonPaths } from "./paths.js";
export declare function daemonStatus(paths: DaemonPaths): Promise<MethodResult<"server/health">>;
export declare function daemonStart(paths: DaemonPaths, cliPath: string, args?: string[]): Promise<MethodResult<"server/health">>;
export declare function daemonStop(paths: DaemonPaths): Promise<void>;
