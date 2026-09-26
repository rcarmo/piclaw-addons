import { defaultConfig, validateConfig, type ResticConfig } from './config.ts';
export interface JobConfig extends ResticConfig {
  binary: string; excludes: string[];
  schedule: { enabled: boolean; hours: number[]; minute: number; timezone: string };
}
export function defaultJobConfig(): JobConfig {
  return { ...defaultConfig(), binary:'managed', excludes:['**/node_modules','**/.cache','**/restic/password','**/restic/env.sh'],
    schedule:{enabled:false,hours:[3,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],minute:0,timezone:'UTC'} };
}
export function validateJobConfig(value: unknown): JobConfig {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('Invalid Restic job config');
  const {binary,excludes,migrationAcknowledged,schedule,...base}=value as JobConfig & {migrationAcknowledged?:unknown};
  // Older saved configs may include the retired checkbox. Accept and discard it.
  if(migrationAcknowledged!==undefined&&typeof migrationAcknowledged!=='boolean')throw Error('Invalid legacy migration acknowledgement');
  const config=validateConfig(base);
  if(typeof binary!=='string'||!binary||/[\x00-\x1f\x7f]/.test(binary)||(!binary.startsWith('/')&&binary!=='restic'&&binary!=='managed'))throw Error('Use managed Restic, restic from PATH or an absolute binary path');
  if(!Array.isArray(excludes)||excludes.length>200||excludes.some(x=>typeof x!=='string'||!x||x.length>512||/[\x00-\x1f\x7f]/.test(x)))throw Error('Invalid exclusions');
  for(const x of excludes)new Bun.Glob(x);
  if(!schedule||Object.keys(schedule).some(x=>!['enabled','hours','minute','timezone'].includes(x)))throw Error('Invalid schedule');
  if(typeof schedule.enabled!=='boolean'||!Array.isArray(schedule.hours)||!schedule.hours.length||schedule.hours.some(x=>!Number.isInteger(x)||x<0||x>23)||!Number.isInteger(schedule.minute)||schedule.minute<0||schedule.minute>59)throw Error('Invalid schedule hours/minute');
  if(typeof schedule.timezone!=='string')throw Error('Invalid timezone');
  try {new Intl.DateTimeFormat('en',{timeZone:schedule.timezone}).format();}catch{throw Error('Invalid timezone');}
  return {...config,binary,excludes:[...excludes],schedule:{...schedule,hours:[...new Set(schedule.hours)].sort((a,b)=>a-b)}};
}
/** One durable cursor claims at most one missed slot. DST repeats are separate UTC slots. */
export function nextRun(schedule: JobConfig['schedule'], after:number):number {
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  let time=Math.floor(after/60000)*60000+60000;
  for(let i=0;i<3*24*60;i++,time+=60000){const parts=fmt.formatToParts(time);const h=Number(parts.find(x=>x.type==='hour')?.value),m=Number(parts.find(x=>x.type==='minute')?.value);if(schedule.hours.includes(h)&&m===schedule.minute)return time;}
  throw Error('No schedule slot within three days');
}
