import { expect, test } from 'bun:test';
import { defaultJobConfig, validateJobConfig } from './job-config.ts';
const configured=()=>({...defaultJobConfig(),repository:{backend:'local' as const,path:'/backups/restic'},passwordRef:'restic/password'});

test('job configuration no longer needs or emits migration acknowledgement',()=>{
 expect(defaultJobConfig()).not.toHaveProperty('migrationAcknowledged');
 const input={...configured(),enabled:true,schedule:{...defaultJobConfig().schedule,enabled:true}};
 expect(validateJobConfig(input)).toEqual(input);
 for(const migrationAcknowledged of [false,true]){
  const legacy={...input,migrationAcknowledged};
  expect(validateJobConfig(legacy)).toEqual(input);
  expect(legacy.migrationAcknowledged).toBe(migrationAcknowledged);
 }
});
test('retired acknowledgement compatibility does not loosen unknown field or schedule validation',()=>{
 for(const migrationAcknowledged of ['yes',0,null])expect(()=>validateJobConfig({...configured(),migrationAcknowledged})).toThrow('Invalid legacy');
 expect(()=>validateJobConfig({...configured(),extra:true})).toThrow('config fields');
 expect(()=>validateJobConfig({...configured(),schedule:{...defaultJobConfig().schedule,enabled:'yes'}})).toThrow('schedule');
 expect(()=>validateJobConfig({...configured(),schedule:{...defaultJobConfig().schedule,timezone:'Invalid/Zone'}})).toThrow('timezone');
});
