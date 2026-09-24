// Wall-clock intervals shared by appointment availability and answering hours.
export const shiftDate = (key, days) => {
  const date = new Date(`${key}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
export const clockMinutes = value => value === '24:00' ? 1440 : /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
export function windowIntervals(windows = []) {
  return (Array.isArray(windows) ? windows : []).flatMap(w => {
    if (w?.allDay) return [[0, 1440]];
    const start = clockMinutes(String(w?.startTime || '').trim()), end = clockMinutes(String(w?.endTime || '').trim());
    return Number.isFinite(start) && Number.isFinite(end) && start !== end ? [[start, end < start ? end + 1440 : end]] : [];
  });
}
export function validateWindows(windows) {
  const intervals = windowIntervals(windows);
  if (intervals.length !== windows.length) throw Object.assign(new Error('Enter valid opening and closing times. Use 24-hour opening for a full day.'), { statusCode: 400 });
  const pieces = intervals.flatMap(([s,e]) => e > 1440 ? [[s,1440],[0,e-1440]] : [[s,e]]).sort((a,b)=>a[0]-b[0]);
  if (pieces.some((p,i)=>i && pieces[i-1][1] > p[0])) throw Object.assign(new Error('Opening periods cannot overlap.'), { statusCode: 400 });
}
const merge = periods => periods.sort((a,b)=>a[0]-b[0]).reduce((result, p)=> {
  const last=result[result.length-1]; if(last && p[0]<=last[1]) last[1]=Math.max(last[1],p[1]); else result.push([...p]); return result;
}, []);
const subtract = (periods, blocks) => blocks.reduce((result,[bs,be])=>result.flatMap(([s,e])=>
  be<=s||bs>=e?[[s,e]]:[[s,Math.min(e,bs)],[Math.max(s,be),e]].filter(([a,b])=>a<b)),periods);
export function dateWindows({ dateKey, rules = [], exceptions = [], scope = 'appointments', emergencyEligible = false }) {
  const applicable = exceptions.filter(e=>e.active!==false && (!e.appliesTo || e.appliesTo==='both' || e.appliesTo===scope));
  const source = key => {
    const day = new Date(`${key}T12:00:00Z`).getUTCDay();
    const rule = rules.find(r=>Number(r.dayOfWeek)===day);
    const changes=applicable.filter(e=>e.date===key);
    const specials=changes.filter(e=>e.type==='special_hours');
    let periods=specials.length?windowIntervals(specials.flatMap(e=>e.windows||[])):
      scope==='answering' && rule?.separateAnsweringHours ? (rule.answeringEnabled ? windowIntervals(rule.answeringWindows) : []) : rule?.enabled ? windowIntervals(rule.windows):[];
    const blocking=changes.filter(e=>e.type!=='special_hours' &&
      !(scope==='answering' && ['fully_booked','emergency_only'].includes(e.type)) &&
      !(e.type==='emergency_only' && emergencyEligible));
    if (blocking.some(e => e.allDay !== false)) return [];
    return subtract(periods,blocking.flatMap(e=>e.allDay!==false?[[0,1440]]:windowIntervals(e.windows)));
  };
  const prior=source(shiftDate(dateKey,-1)).filter(([,e])=>e>1440).map(([s,e])=>[Math.max(0,s-1440),e-1440]);
  let periods=merge([...source(dateKey),...prior].map(([s,e])=>[s,Math.min(e,1440)]));
  const todayBlocks=applicable.filter(e=>e.date===dateKey && e.type!=='special_hours' &&
    !(scope==='answering' && ['fully_booked','emergency_only'].includes(e.type)) && !(e.type==='emergency_only' && emergencyEligible));
  const overnightBlocks=applicable.filter(e=>e.date===shiftDate(dateKey,-1) && e.allDay===false && e.type!=='special_hours' &&
    !(scope==='answering' && ['fully_booked','emergency_only'].includes(e.type)) && !(e.type==='emergency_only' && emergencyEligible))
    .flatMap(e=>windowIntervals(e.windows)).filter(([,end])=>end>1440).map(([start,end])=>[Math.max(0,start-1440),end-1440]);
  periods=subtract(periods,overnightBlocks);
  periods=subtract(periods,todayBlocks.flatMap(e=>e.allDay!==false?[[0,1440]]:windowIntervals(e.windows)));
  return periods;
}
