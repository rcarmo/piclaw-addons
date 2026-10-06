import { expect, test } from 'bun:test';
import { captureLaunchPolicy, createHostAdmission, type AdmittedInvocationV1, type FiniteLaunchPolicyV1, type HostDomainProvisionerV1, type HostOwnedTask, type ProvisionedDomainV1 } from './host-admission.ts';
import type { ChildRequestScopeV1 } from './contracts.ts';

const hash = 'a'.repeat(64);
function policy(): FiniteLaunchPolicyV1 {
  return { helper:'/approved/helper',helperSha256:hash,runtime:[
    {source:'/approved/bun',target:'bin/bun',sha256:hash,executable:true},
    {source:'/approved/bash',target:'bin/bash',sha256:hash,executable:true},
    {source:'/approved/child.js',target:'app/child.js',sha256:hash}],
    files:[{source:'/approved/export/input',exportRoot:'/approved/export',target:'input',sha256:hash}],
    profile:'read_only',tools:['read','bash'],entrypoint:'/app/child.js',args:['fixture'],
    limits:{cpuQuotaMicros:50000,cpuPeriodMicros:100000,cpuTimeMs:5000,memoryBytes:256*1024*1024,pids:64,writableBytes:32*1024*1024,writableInodes:1024} };
}
const gate = <T=void>()=>{let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function task<T>(value:Promise<T>, settled:Promise<void>=value.then(()=>{},()=>{}), cancel=()=>{}):HostOwnedTask<T>{return{result:value,settled,cancel}}
function fixture() {
  const events:string[]=[], signal=new AbortController(); let allowed=true,scopeCloses=0,domainCloses=0;
  const invocation:AdmittedInvocationV1={addonId:'delegate',workId:'work',chatJid:'web:fixture',toolCallId:'tool',model:{provider:'synthetic',id:'fixture'},deadlineAt:Date.now()+5000,signal:signal.signal,authorise(){events.push('authorise');if(!allowed)throw Error('PRIVATE revocation')}};
  const scope:ChildRequestScopeV1={plan:{version:1,execution:'parent-provider-proxy',model:invocation.model,mcp:'none'},stream(){throw Error('fixture has no provider')},async close(){scopeCloses++;events.push('scope-close')}};
  const domain:ProvisionedDomainV1={execute(input){events.push('execute');input.authorise();return task(Promise.resolve({exitCode:0,output:'fixture result'}))},async close(){domainCloses++;events.push('domain-close')}};
  const provisioner:HostDomainProvisionerV1={kind:'synthetic-test-domain-v1',provision(){events.push('provision');return task(Promise.resolve(domain))}};
  return{events,signal,invocation,scope,domain,provisioner,revoke(){allowed=false},counts:()=>({scopeCloses,domainCloses})};
}

test('absent production provisioner and synthetic production fallback fail before staging or launch',async()=>{
  for(const provisioner of [undefined,fixture().provisioner]){
    const f=fixture(), host=createHostAdmission({mode:'production',policy:policy(),provisioner});
    expect(()=>host.admit(f.invocation,f.scope)).toThrow('UNSUPPORTED_DOMAIN');expect(f.events).toEqual([]);await host.close();
  }
});

test('captures immutable finite launch grants and invocation before provider execution; one use only',async()=>{
  const f=fixture(),p=policy();let observed:any;
  f.domain.execute=input=>{observed=input;input.authorise();return task(Promise.resolve({exitCode:0,output:'ok'}))};
  const host=createHostAdmission({mode:'offline-test',policy:p,provisioner:f.provisioner}), handle=host.admit(f.invocation,f.scope);
  p.files[0].source='/live/secrets';p.limits.memoryBytes=1;f.invocation.workId='foreign';f.invocation.model.id='foreign';
  await expect(handle.run()).resolves.toEqual({exitCode:0,output:'ok'});await expect(handle.run()).rejects.toThrow('DENIED');await handle.close();await host.close();
  expect(observed.binding.workId).toBe('work');expect(observed.binding.model.id).toBe('fixture');expect(observed.policy.files[0].source).toBe('/approved/export/input');
  expect(observed.policy.limits.memoryBytes).toBe(256*1024*1024);expect(Object.isFrozen(observed.policy.files[0])).toBe(true);expect(Object.isFrozen(observed.binding.model)).toBe(true);
  expect(f.counts()).toEqual({scopeCloses:1,domainCloses:1});
});

test('policy rejects missing quotas, path escape, extra authority, conflicting targets and tool downgrade',()=>{
  const changes:Array<(p:FiniteLaunchPolicyV1)=>void>=[
    p=>{delete (p.limits as any).pids},p=>{p.limits.memoryBytes=0},p=>{p.limits.cpuQuotaMicros=Infinity},p=>{p.files[0].target='../escape'},
    p=>{p.files[0].source='/other/secret'},p=>{(p.files[0] as any).account='spoof'},p=>{p.runtime=[...p.runtime,{...p.runtime[2],target:'app/child.js/nested'}]},
    p=>{p.tools=[]},p=>{p.tools=['read'];p.profile='workspace_write'},p=>{p.args=['x'.repeat(33000)]},p=>{p.entrypoint='/work/child.js'},
    p=>{p.helperSha256='bad'},p=>{p.runtime=p.runtime.filter(f=>f.target!=='bin/bun')},p=>{(p as any).quotaOverride=true},
  ];
  for(const change of changes){const p=policy();change(p);expect(()=>captureLaunchPolicy(p)).toThrow('INVALID_POLICY')}
});

test('scope/model mismatch and child-like identity fields cannot alter captured authority',async()=>{
  const f=fixture(),host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner});
  expect(()=>host.admit({...f.invocation,accountId:'spoof'} as any,f.scope)).toThrow('INVALID_POLICY');
  expect(()=>host.admit({...f.invocation,model:{provider:'other',id:'fixture'}},f.scope)).toThrow('DENIED');
  expect(()=>host.admit({...f.invocation,deadlineAt:Date.now()-1},f.scope)).toThrow('DENIED');await host.close();expect(f.events).toEqual([]);
});

test('delayed domain allocation is owned through cancellation; late domain never executes',async()=>{
  const f=fixture(),allocated=gate<ProvisionedDomainV1>(),raw=gate(),closeRaw=gate();let cancels=0;
  f.provisioner.provision=()=>task(allocated.promise,raw.promise,()=>{cancels++});f.domain.close=()=>{f.events.push('domain-close');return closeRaw.promise};
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),handle=host.admit(f.invocation,f.scope);
  const running=handle.run();void running.catch(()=>{});await tick();f.signal.abort();let closed=false;const close=host.close().then(()=>{closed=true});
  allocated.resolve(f.domain);await tick();expect(f.events).not.toContain('execute');expect(f.events).toContain('domain-close');expect(closed).toBe(false);
  raw.resolve();await tick();expect(closed).toBe(false);closeRaw.resolve();await close;await expect(running).rejects.toThrow('CANCELLED');expect(cancels).toBeGreaterThan(0);
});

test('success delivery cannot release raw executor, domain or host-scope obligations',async()=>{
  const f=fixture(),raw=gate(),scopeTail=gate(),domainTail=gate();
  f.domain.execute=input=>{input.authorise();return task(Promise.resolve({exitCode:0,output:'ok'}),raw.promise)};
  f.scope.close=()=>scopeTail.promise;f.domain.close=()=>domainTail.promise;
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),handle=host.admit(f.invocation,f.scope);
  let finished=false;const running=handle.run().then(()=>{finished=true});await tick();expect(finished).toBe(false);raw.resolve();await tick();expect(finished).toBe(false);
  domainTail.resolve();await tick();expect(finished).toBe(false);scopeTail.resolve();await running;await host.close();expect(finished).toBe(true);
});

test('host shutdown reentrancy during allocation returns no executable domain and waits cleanup',async()=>{
  const f=fixture(),tail=gate();let stop:Promise<void>|undefined,stopped=false;
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:{kind:'synthetic-test-domain-v1',provision(){stop=host.close().then(()=>{stopped=true});return task(Promise.resolve(f.domain),tail.promise)}}});
  const handle=host.admit(f.invocation,f.scope),running=handle.run();void running.catch(()=>{});await tick();expect(f.events).not.toContain('execute');expect(stopped).toBe(false);
  tail.resolve();await stop;await expect(running).rejects.toThrow('CANCELLED');expect(f.counts()).toEqual({scopeCloses:1,domainCloses:1});
});

test('deadline covers provisioning and cleanup remains tracked after delivery cancellation',async()=>{
  const f=fixture(),tail=gate<ProvisionedDomainV1>();f.invocation.deadlineAt=Date.now()+20;
  f.provisioner.provision=()=>task(tail.promise);
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),handle=host.admit(f.invocation,f.scope),running=handle.run();void running.catch(()=>{});
  await new Promise(r=>setTimeout(r,35));tail.resolve(f.domain);await expect(running).rejects.toThrow('CANCELLED');await host.close();expect(f.events).not.toContain('execute');
});

test('revocation after allocation denies execution and closes allocated resources',async()=>{
  const f=fixture();f.provisioner.provision=()=>{f.revoke();return task(Promise.resolve(f.domain))};
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner});await expect(host.admit(f.invocation,f.scope).run()).rejects.toThrow('FAILED');
  await host.close();expect(f.events).not.toContain('execute');expect(f.counts()).toEqual({scopeCloses:1,domainCloses:1});
});

test('unawaited async authority callbacks deny launch but remain owned until completion',async()=>{
  const f=fixture(),tail=gate();f.invocation.authorise=(async()=>{await tail.promise}) as ()=>void;
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),run=host.admit(f.invocation,f.scope).run();void run.catch(()=>{});
  let finished=false;void run.finally(()=>{finished=true}).catch(()=>{});await tick();expect(finished).toBe(false);expect(f.events).not.toContain('provision');tail.resolve();await expect(run).rejects.toThrow('FAILED');await host.close();
});

test('cleanup failures are sticky even after rejected execution, never a successful host shutdown',async()=>{
  const f=fixture(),raw=gate();f.domain.execute=()=>task(Promise.reject(Error('PRIVATE execute failure')),raw.promise);f.domain.close=async()=>{throw Error('PRIVATE release failure')};
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),run=host.admit(f.invocation,f.scope).run();void run.catch(()=>{});
  await tick();let stopped=false;const closing=host.close().finally(()=>{stopped=true});void closing.catch(()=>{});await tick();expect(stopped).toBe(false);
  raw.resolve();await expect(run).rejects.toThrow('CLEANUP_FAILED');await expect(closing).rejects.toThrow('CLEANUP_FAILED');
});

test('close without running owns scope cleanup and never allocates a domain',async()=>{
  const f=fixture(),host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),handle=host.admit(f.invocation,f.scope);
  expect(handle.close()).toBe(handle.close());await handle.close();await expect(handle.run()).rejects.toThrow('DENIED');expect(f.events).toEqual(['scope-close']);await host.close();
});

test('allocation result alone is not permission to execute before provisioner setup has settled',async()=>{
  const f=fixture(),raw=gate();f.provisioner.provision=()=>task(Promise.resolve(f.domain),raw.promise);
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),run=host.admit(f.invocation,f.scope).run();
  await tick();expect(f.events).not.toContain('execute');raw.resolve();await run;expect(f.events).toContain('execute');await host.close();
});

test('close failure without run cannot disappear from later host shutdown',async()=>{
  const f=fixture();f.scope.close=async()=>{throw Error('PRIVATE close failure')};
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),handle=host.admit(f.invocation,f.scope);
  await expect(handle.close()).rejects.toThrow('CLEANUP_FAILED');await expect(host.close()).rejects.toThrow('CLEANUP_FAILED');expect(f.events).toEqual([]);
});

test('execution after cancellation is denied and held execution tail is not replaced by cancel failure',async()=>{
  const f=fixture(),entered=gate(),tail=gate();let guarded:Parameters<ProvisionedDomainV1['execute']>[0]|undefined,cancels=0;
  f.domain.execute=input=>{guarded=input;entered.resolve();return task(tail.promise.then(()=>({exitCode:0,output:'late'})),tail.promise,()=>{cancels++;throw Error('PRIVATE cancellation failure')})};
  const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner}),handle=host.admit(f.invocation,f.scope),running=handle.run();void running.catch(()=>{});
  await entered.promise;f.signal.abort();await tick();expect(()=>guarded!.authorise()).toThrow('CANCELLED');expect(()=>guarded!.scope.stream({messages:[]},{},{requestId:'late'})).toThrow('CANCELLED');
  let closed=false;const closing=host.close().finally(()=>{closed=true});void closing.catch(()=>{});await tick();expect(closed).toBe(false);
  tail.resolve();await expect(running).rejects.toThrow('CLEANUP_FAILED');await expect(closing).rejects.toThrow('CLEANUP_FAILED');expect(cancels).toBe(1);
});

test('unqualified resource provider kind cannot be relabelled after host capture',async()=>{
  const f=fixture(),host=createHostAdmission({mode:'production',policy:policy(),provisioner:f.provisioner});
  f.provisioner.kind='qualified-linux-resource-domain-v1';expect(()=>host.admit(f.invocation,f.scope)).toThrow('UNSUPPORTED_DOMAIN');await host.close();
});

test('provider failure and output overflow close domain and provider scope without returning raw diagnostics',async()=>{
  for(const kind of ['provision','execute','overflow']){
    const f=fixture();if(kind==='provision')f.provisioner.provision=()=>{throw Error('PRIVATE provision error')};
    else f.domain.execute=()=>kind==='execute'?task(Promise.reject(Error('PRIVATE execute error'))):task(Promise.resolve({exitCode:0,output:'x'.repeat(64001)}));
    const host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner});
    await expect(host.admit(f.invocation,f.scope).run()).rejects.toThrow('FAILED');await host.close();
    expect(f.counts()).toEqual({scopeCloses:1,domainCloses:kind==='provision'?0:1});
  }
});

test('one scope cannot be admitted twice or recycled after close',async()=>{
  const f=fixture(),host=createHostAdmission({mode:'offline-test',policy:policy(),provisioner:f.provisioner});
  const handle=host.admit(f.invocation,f.scope);expect(()=>host.admit(f.invocation,f.scope)).toThrow('DENIED');
  await handle.close();expect(()=>host.admit(f.invocation,f.scope)).toThrow('DENIED');await host.close();expect(f.counts().scopeCloses).toBe(1);
});
