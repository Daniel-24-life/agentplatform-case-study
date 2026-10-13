import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createProductWorkflowFixture, waitForProductRun } from '../helpers/product-workflow.js';
const target=process.env.AGENTPLATFORM_PHASE27_UI_FIXTURE;
it.skipIf(!target)('prepares only a registered isolated zero-model UI fixture',async()=>{
 const root=readFileSync('docs/PHASE_1_27_EVIDENCE_ROOT.txt','utf8').trim();
 const relative=path.relative(path.resolve(root),path.resolve(target!));
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||existsSync(target!))throw Error('Fresh registered evidence child required');
 mkdirSync(target!,{recursive:true});const f=await createProductWorkflowFixture(target!);
 try {await f.runs.start(f.input);expect(await waitForProductRun(f)).toMatchObject({status:'SUCCEEDED'});}
 finally {f.database.close();}
 renameSync(path.join(target!,'app.db'),path.join(target!,'agentplatform.db'));
},30000);
