import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkPreparedDependencies } from "./check-prepared-dependencies.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync("/tmp/piclaw-addon-e2e-closure-"); roots.push(root);
  const workspace = join(root, "workspace"), addon = join(workspace, ".pi/extensions/node_modules/@rcarmo/piclaw-addon-remote-peer"); mkdirSync(addon,{recursive:true});
  const packageFile=(base:string,name:string,source="export const value=1;")=>{const dir=join(base,name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"package.json"),JSON.stringify({name,type:"module",main:"index.js"}));writeFileSync(join(dir,"index.js"),source);};
  const shared=join(root,"node_modules"),privateRoot=join(addon,"node_modules");
  packageFile(shared,"@earendil-works/pi-ai");packageFile(shared,"partial-json");
  return {root,workspace,addon,shared,privateRoot,packageFile};
}
test("closure requires private runtime deps and canonical transitive ownership",()=>{
  try {
    const f=fixture();f.packageFile(f.shared,"@number0/iroh");f.packageFile(f.shared,"bonjour-service");
    mkdirSync(f.privateRoot);
    expect(()=>checkPreparedDependencies(f.root,f.workspace)).toThrow("missing from private install");
    const valid=fixture();valid.packageFile(valid.privateRoot,"@number0/iroh");valid.packageFile(valid.privateRoot,"bonjour-service");
    expect(checkPreparedDependencies(valid.root,valid.workspace).preparedDependencies).toBe("pass");
    const escaped=fixture();escaped.packageFile(escaped.privateRoot,"@number0/iroh");escaped.packageFile(escaped.privateRoot,"bonjour-service");
    const outside=mkdtempSync("/tmp/forbidden-closure-");roots.push(outside);escaped.packageFile(outside,"partial-json");
    rmSync(join(escaped.shared,"partial-json"),{recursive:true});symlinkSync(join(outside,"partial-json"),join(escaped.shared,"partial-json"));
    expect(()=>checkPreparedDependencies(escaped.root,escaped.workspace)).toThrow("escapes owned fixture");
    const transitive=fixture();transitive.packageFile(transitive.privateRoot,"@number0/iroh");transitive.packageFile(transitive.privateRoot,"bonjour-service");
    const nested=join(transitive.shared,"@earendil-works/pi-ai/node_modules");mkdirSync(nested,{recursive:true});
    symlinkSync(join(outside,"partial-json"),join(nested,"partial-json"));
    expect(()=>checkPreparedDependencies(transitive.root,transitive.workspace)).toThrow("Peer transitive dependency escaped fixture");
  } finally {for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});}
});
