import {expect,test} from "bun:test";
test("external thread adoption contract",async()=>{
  const child=Bun.spawn([process.execPath,"run","scripts/mobile-verify/as-adopt-regression.ts"],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,detail:code?stdout+stderr:"passed"}).toEqual({code:0,detail:"passed"});
},30000);
