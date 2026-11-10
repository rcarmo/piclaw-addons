import{expect,test}from'bun:test';import{readFileSync}from'node:fs';
test('current Regrets wiring describes scoped observation without the removed ledger helper',()=>{
 const doc=readFileSync(new URL('./addons/late-night-regrets/NATIVE.md',import.meta.url),'utf8');
 expect(doc).not.toContain('createHostRegretsAccountedDecision');expect(doc).not.toContain('retains failed/uncertain cost evidence');
 expect(doc).toContain('accountedDecision');expect(doc).toContain('no financial admission or settlement authority');
 expect(doc).toContain('Historical monetary records remain opaque and unchanged');
});
test('usage chart distinguishes exporter currencies from its intentionally narrow additive whitelist',()=>{
 const doc=readFileSync(new URL('./addons/observability/skills/usage-telemetry-chart/SKILL.md',import.meta.url),'utf8');
 expect(doc).toContain('separate for each explicit currency');expect(doc).toContain('individual unknown-unit observations');
 expect(doc).toContain('provider-native, legacy and retired ambiguous');expect(doc).not.toContain('Provider-native amounts have unknown currency');
});
