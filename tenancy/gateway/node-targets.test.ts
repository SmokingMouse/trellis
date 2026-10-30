import { expect, test } from "bun:test";
import { openGatewayDB } from "./db";
import { addUser } from "./auth";
import { addNode } from "./tunnel";
import { exportBlocked, machineNames, nodePolicy, parseVia, setNodePolicy, targetFor } from "./node-targets";
import type { SessionUser } from "./auth";

const db = openGatewayDB(":memory:");
addUser(db, "admin", "host-admin", "admin");
addUser(db, "other", "host-other", "user");
const row = (name: string) => db.prepare("SELECT id, tenant FROM users WHERE name=?").get(name) as { id: string; tenant: string };
const me = { ...row("admin"), name: "admin", role: "admin" } as unknown as SessionUser;
const other = { ...row("other"), name: "other", role: "user" } as unknown as SessionUser;
addNode(db, "office", me.id);

test("parseVia 只放行 /api/ 且拒绝路径穿越", () => {
  expect(parseVia("/__gw/via/office/api/runs")).toEqual({ name: "office", path: "/api/runs" });
  expect(parseVia("/__gw/via/office/settings")).toBeNull();
  expect(parseVia("/__gw/via/office/api/../login")).toBeNull();
  expect(parseVia("/__gw/via/office//api/x")).toBeNull();
  expect(parseVia("/__gw/via/Office/api/x")).toBeNull();
});

test("默认策略：本机全开，远端全关；可改", () => {
  expect(nodePolicy(db, me, me.tenant)).toEqual({ shareOut: true, acceptDispatch: true });
  expect(nodePolicy(db, me, "office")).toEqual({ shareOut: false, acceptDispatch: false });
  expect(setNodePolicy(db, me, "office", { acceptDispatch: true })).toEqual({ shareOut: false, acceptDispatch: true });
  expect(nodePolicy(db, me, "office").acceptDispatch).toBe(true);
});

test("exportBlocked 只拦 /api/export/* 且看来源机器的 shareOut", async () => {
  expect(exportBlocked(db, me, "office", "/api/runs")).toBeNull();
  const res = exportBlocked(db, me, "office", "/api/export/session/abc");
  expect(res?.status).toBe(403);
  expect(exportBlocked(db, me, me.tenant, "/api/export/session/abc")).toBeNull();
  setNodePolicy(db, me, "office", { shareOut: true });
  expect(exportBlocked(db, me, "office", "/api/export/session/abc")).toBeNull();
});

test("targetFor 只认自己名下的机器；离线报 offline", () => {
  expect(targetFor(db, me, "office")).toEqual({ offline: "office" });
  expect(targetFor(db, other, "office")).toBeNull();
  expect(machineNames(db, me)).toEqual([me.tenant, "office"]);
});
