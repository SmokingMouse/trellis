import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { AgentClient } from "@smokingmouse/agent-server";
import { loadToken } from "@smokingmouse/agent-server/paths";

const db = new Database(process.env.TRELLIS_DB_PATH!,{readonly:true});
const mapping = (nodeId:string) => db.query("SELECT thread_id,last_item_id,turn_id FROM as_turns WHERE node_id=?").get(nodeId) as {thread_id:string;last_item_id:string;turn_id:string};
const parent = mapping(process.argv[2]), child = mapping(process.argv[3]);
assert.ok(parent && child);
assert.notEqual(parent.thread_id,child.thread_id);
const client = await AgentClient.connectUnix({path:process.env.TRELLIS_AS_SOCKET!,token:loadToken(process.env.TRELLIS_AS_TOKEN_PATH!),reconnect:false});
try {
  const source = await client.request("thread/attach",{threadId:parent.thread_id,sinceSeq:0});
  const target = await client.request("thread/attach",{threadId:child.thread_id,sinceSeq:0});
  assert.equal(client.initializeResult?.capabilities.midThreadFork,true);
  assert.deepEqual(target.thread.forkedFrom,{threadId:parent.thread_id,itemId:parent.last_item_id});
  const index = source.items.findIndex(i=>i.id === parent.last_item_id);
  assert.ok(index >= 0);
  const project = (items:typeof source.items) => items.map(i=>({id:i.id,type:i.type,payload:i.payload,status:i.status}));
  const prefix = source.items.slice(0,index+1);
  assert.deepEqual(project(target.items.filter(i=>i.turnId !== child.turn_id)),project(prefix));
  const own = target.items.filter(i=>i.turnId === child.turn_id);
  const user = own.find(i=>i.type === "userMessage");
  const node = db.query("SELECT question FROM nodes WHERE id=?").get(process.argv[3]) as {question:string};
  assert.ok(user?.type === "userMessage");
  assert.deepEqual(user.payload.content,[{type:"text",text:node.question}]);
  console.log(`PASS: fork ${child.thread_id} inherits exactly ${prefix.length} items through ${parent.last_item_id}; new input is unseeded`);
} finally {client.close();db.close();}
