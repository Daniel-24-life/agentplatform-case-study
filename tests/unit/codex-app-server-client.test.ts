import { describe, expect, it } from "vitest";
import process from "node:process";
import { CodexAppServerClient } from "../../src/main/adapters/codex/codex-app-server-client.js";

// Process startup can exceed 120 ms when the full suite is concurrently creating
// disposable Git fixtures. Keep this a bounded unit timeout without making it a
// scheduler-speed assertion.
const fake = (body:string, ...args:string[]) => new CodexAppServerClient({ program:process.execPath, prefixArgs:["-e", body, ...args], timeoutMs:1_000 });
const server = `let b='';process.stdin.on('data',c=>{b+=c;for(;;){let n=b.indexOf('\\n');if(n<0)break;let x=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(x.id===undefined)continue;${"__BODY__"}}})`;
const reply = (expr:string) => server.replace("__BODY__",`process.stdout.write(JSON.stringify(${expr})+'\\n');`);

describe("CodexAppServerClient",()=>{
  it("uses absolute executable, prefix args, shell false and correlates success",async()=>{
    const c=fake(reply("({jsonrpc:'2.0',id:x.id,result:{ok:true}})"),"marker");
    expect(await c.initialize()).toEqual({ok:true}); await c.close();
  });
  it("builds required initialize and read-only start params",async()=>{
    const c=fake(reply("({jsonrpc:'2.0',id:x.id,result:x.params})"));
    expect(await c.initialize()).toMatchObject({clientInfo:{name:"agentplatform",version:"0.1.0"},capabilities:{experimentalApi:true,requestAttestation:false}});
    expect(await c.accountRead()).toEqual({refreshToken:false});
    expect(await c.threadStart({cwd:"C:/repo",model:"gpt-5.6-luna",reasoning:"medium"})).toMatchObject({approvalPolicy:"never",sandbox:"read-only",ephemeral:true,config:{model_reasoning_effort:"medium"}}); await c.close();
    expect(c.getProcessDiagnostics()).toMatchObject({closeObserved:true,stdoutClosed:true,stderrClosed:true,terminationRequested:true});
  });
  it("rejects remote error, malformed and unknown id",async()=>{
    await expect(fake(reply("({jsonrpc:'2.0',id:x.id,error:{code:7}})")).initialize()).rejects.toThrow("remote error");
    await expect(fake(server.replace("__BODY__","process.stdout.write('bad\\n');")).initialize()).rejects.toThrow("malformed");
    await expect(fake(server.replace("__BODY__","process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999,result:{}})+'\\n');")).initialize()).rejects.toThrow("unknown");
  });
  it("fails on early exit and oversize line/output",async()=>{
    await expect(fake(server.replace("__BODY__","process.exit(0);")).initialize()).rejects.toThrow("early");
    await expect(new CodexAppServerClient({program:process.execPath,prefixArgs:["-e",server.replace("__BODY__","process.stdout.write('x'.repeat(100)+'\\n');")],lineLimitBytes:8,timeoutMs:1_000}).initialize()).rejects.toThrow("oversize");
  });
  it("times out and sends interrupt on cancellation",async()=>{
    const c=fake(server.replace("__BODY__","if(x.method==='turn/start')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{turn:{id:'t1'}}})+'\\n');"));
    await expect(c.initialize()).rejects.toThrow("timeout");
    const c2=fake(reply("({jsonrpc:'2.0',id:x.id,result:{turn:{id:'t1'}}})"));
    await c2.initialize(); await c2.cancel("th","t1");
  });
  it("waits for the matching turn/completed notification",async()=>{
    const body = server.replace("__BODY__", `
      if(x.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{ok:true}})+'\\n');
      else if(x.method==='thread/start') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{thread:{id:'th1'}}})+'\\n');
      else if(x.method==='turn/start') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{turn:{id:'t1'}}})+'\\n');
        setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'th1',turn:{id:'t1',status:'completed',items:[]}}})+'\\n'),5);
      }
    `);
    const client=fake(body);
    await client.initialize();
    const thread=await client.threadStart({cwd:"C:/repo",model:"gpt-5.6-luna"}) as {thread:{id:string}};
    const result=await client.turnStart(thread.thread.id,"hello",{type:"object"});
    expect(result).toMatchObject({threadId:"th1",turnId:"t1",terminal:{threadId:"th1",turn:{status:"completed"}}});
    await client.close();
  });
});
