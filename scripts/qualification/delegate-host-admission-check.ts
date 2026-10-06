import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

/** Focused synthetic contract qualification; does not launch a domain or test OS limits. */
const [sdkRoot, output] = process.argv.slice(2);
if (!sdkRoot || !output || process.argv.length !== 4) throw Error('Usage: bun delegate-host-admission-check.ts ISOLATED_PI103_ROOT NEW_EVIDENCE_DIR');
const root = resolve(import.meta.dir, '../..'), out = resolve(output), deps = join(resolve(sdkRoot), 'node_modules');
if (JSON.parse(readFileSync(join(deps, '@earendil-works/pi-ai/package.json'), 'utf8')).version !== '1.0.3') throw Error('Expected isolated public Pi1.0.3 declarations');
mkdirSync(out); // never overwrite a previous receipt
const require = createRequire(join(root, 'package.json'));
const tsRoot = require.resolve('typescript/package.json').replace(/\/package\.json$/, '');
const bunTypesRoot = require.resolve('bun-types/package.json').replace(/\/bun-types\/package\.json$/, '');
const files = ['host-admission.ts', 'host-admission.test.ts', 'HOST-ADMISSION.md'].map(p=>join(root,'experimental/delegate-parent-proxy',p));
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const before = Object.fromEntries(files.map(p=>[p,hash(p)]));
const config = { compilerOptions: { target:'ES2022',module:'ESNext',moduleResolution:'bundler',strict:true,noEmit:true,skipLibCheck:true,
  allowImportingTsExtensions:true,types:['bun-types'],typeRoots:[bunTypesRoot,join(bunTypesRoot,'@types')],
  paths:{'@earendil-works/pi-ai':[join(deps,'@earendil-works/pi-ai/dist/index.d.ts')]} },include:files.filter(p=>p.endsWith('.ts')) };
writeFileSync(join(out,'tsconfig.json'),JSON.stringify(config,null,2));
const commands: Array<[string,string[]]> = [
  ['types',[process.execPath,join(tsRoot,'bin/tsc'),'-p',join(out,'tsconfig.json')]],
  ['tests',[process.execPath,'test','experimental/delegate-parent-proxy/host-admission.test.ts']],
];
const results=[];
for (const [label,command] of commands) {
  const proc = Bun.spawn(['nice','-n','10',...command], {cwd:root,stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,exitCode]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  writeFileSync(join(out,label+'.log'),stdout+stderr);console.log(label,exitCode,stderr.slice(-220));
  results.push({label,exitCode});if(exitCode)throw Error(label+' failed; logs preserved');
}
const after=Object.fromEntries(files.map(p=>[p,hash(p)]));if(JSON.stringify(after)!==JSON.stringify(before))throw Error('Source changed during qualification');
writeFileSync(join(out,'receipt.json'),JSON.stringify({date:new Date().toISOString(),sourceHead:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim(),hashes:after,results,
  typeScope:'strict source check against existing public pi-ai1.0.3 declarations, skipLibCheck',
  testScope:'synthetic provisioner only; no OS-domain allocation, child launch, cgroup/service mutation or hard-quota proof',
  production:'unsupported without independently qualified provisioner',frozenParents:['175/8096c00','177/60cff61']},null,2)+'\n');
