import os from "node:os";
import path from "node:path";
import type { Mode } from "@/lib/llm/types";

// chat session transcripts land here. chat has no user-facing cwd binding, but
// B-fork needs a STABLE spawn dir so spawn / resume-validation / cleanup all
// agree on where the jsonl lives. Shared by the provider (spawn cwd), the repo
// (resume check + cleanup paths), and scratch-ensure. Giving chat a scratch
// cwd also flips it out of whatever dir the server happens to run in, so it
// never picks up a stray project CLAUDE.md.
export const CHAT_SCRATCH = path.join(os.homedir(), ".trellis", "chat-scratch");

// The cwd claude is spawned in IS where its session jsonl lands, so spawn,
// resume validation, and cleanup must all use this one value — centralized here
// so they can never disagree (the bug that made B-fork resume silently fail:
// spawn used the process cwd while validation computed the home dir). chat →
// dedicated scratch dir; project → their bound path.
export function sessionCwd(
  mode: Mode,
  workspacePath: string | null,
): string | null {
  return mode === "chat" ? CHAT_SCRATCH : workspacePath;
}
