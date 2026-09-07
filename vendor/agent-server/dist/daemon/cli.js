#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { daemonStart, daemonStatus, daemonStop } from "./control.js";
import { resolveDaemonPaths } from "./paths.js";
import { runDaemon } from "./runtime.js";
const usage = "Usage: agent-server run [--ws-port PORT] [--grace-ms MS]\n       agent-server daemon start [--ws-port PORT] [--grace-ms MS]\n       agent-server daemon stop|status";
function parseOptions(args) {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        const flag = args[i], value = args[i + 1];
        if ((flag !== "--ws-port" && flag !== "--grace-ms") || value === undefined || !/^\d+$/.test(value))
            throw new Error(usage);
        const number = Number(value), max = flag === "--ws-port" ? 65535 : 300_000;
        if (!Number.isSafeInteger(number) || number > max)
            throw new Error(`${flag} must be from 0 to ${max}`);
        if (flag === "--ws-port")
            options.wsPort = number;
        else
            options.graceMs = number;
    }
    return options;
}
export async function main(args = process.argv.slice(2)) {
    try {
        if (args[0] === "--help" || args[0] === "-h") {
            console.log(usage);
            return 0;
        }
        const paths = resolveDaemonPaths();
        if (args[0] === "run") {
            const daemon = await runDaemon({ ...parseOptions(args.slice(1)), paths,
                // Detached stdout already targets logPath. Runtime writes each lifecycle line there once.
                ...(process.env.AGENT_SERVER_DAEMON_CHILD === "1" ? { logger: () => { } } : {}),
            });
            const terminate = (signal) => { void daemon.shutdown(signal).catch(() => { }); };
            const sigterm = () => terminate("SIGTERM"), sigint = () => terminate("SIGINT");
            process.on("SIGTERM", sigterm);
            process.on("SIGINT", sigint);
            await daemon.closed;
            process.off("SIGTERM", sigterm);
            process.off("SIGINT", sigint);
            await daemon.shutdown();
            return 0;
        }
        if (args[0] !== "daemon")
            throw new Error(usage);
        if (args[1] === "start") {
            parseOptions(args.slice(2));
            const health = await daemonStart(paths, fileURLToPath(import.meta.url), args.slice(2));
            console.log(JSON.stringify({ socketPath: paths.socketPath, ...health }));
            return 0;
        }
        if (args.length !== 2)
            throw new Error(usage);
        if (args[1] === "status") {
            console.log(JSON.stringify(await daemonStatus(paths)));
            return 0;
        }
        if (args[1] === "stop") {
            await daemonStop(paths);
            console.log("agent-server stopped");
            return 0;
        }
        throw new Error(usage);
    }
    catch (error) {
        console.error(`agent-server: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
if (import.meta.main)
    process.exitCode = await main();
