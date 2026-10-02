import { normalizeServiceText as normalize } from '../catalog/servicePhrase.service.js';

// Evidence vocabulary, never a license, approved offering, price, or booking permission.
// Business type is deliberately not an input to service matching.
export const TRADE_PROFILE_VERSION = 1;
export const TRADE_DOMAINS = Object.freeze({
  plumbing: /\b(?:plumb(?:er|ing)?|pipe|pipes|faucet|toilet|bathtub|tub|shower|sink|drain|sewer|water heater|hot water heater|sump pump|septic)\b/,
  hvac: /\b(?:hvac|ac|air conditioner|air conditioning|furnace|heat pump|thermostat|duct|ductwork|no heat|no cooling|refrigerant)\b/,
  roofing: /\b(?:roof|roofer|roofing|shingles?|flashing|skylight)\b/,
  electrical: /\b(?:electrician|electrical|outlets?|breakers?|circuits?|wiring|panel|light switch)\b/,
  restoration: /\b(?:restoration|water damage|mold|remediation|drying|smoke damage|fire damage)\b/,
  garage_door: /\b(?:garage doors?|garage opener|garage spring|torsion spring)\b/,
  locksmith: /\b(?:locksmith|lockout|locked out|rekey|door lock|deadbolt|key broke|broken key)\b/,
  landscaping: /\b(?:landscap(?:e|ing)|lawn|mow(?:ing)?|tree|hedge|irrigation|sprinkler|sod)\b/,
  appliance_repair: /\b(?:appliance|refrigerator|fridge|freezer|dishwasher|washing machine|washer|dryer|oven|stove|cooktop|range hood|microwave)\b/,
});
const aliases = { plumber:'plumbing', roofer:'roofing', roof:'roofing', electrician:'electrical', 'heating and cooling':'hvac', 'garage door':'garage_door', 'garage doors':'garage_door', 'appliance repair':'appliance_repair', appliances:'appliance_repair', appliance:'appliance_repair' };
export const canonicalTrade = value => aliases[normalize(value)] || Object.keys(TRADE_DOMAINS).find(key => normalize(key) === normalize(value)) || normalize(value);
export function detectServiceTrades(value) {
  const text=normalize(value);
  const found=Object.entries(TRADE_DOMAINS).filter(([,pattern])=>pattern.test(text)).map(([key])=>key);
  // Loss of cooling and refrigerant belong to appliances too. Do not invent a
  // second trade when an appliance is named without independent HVAC equipment.
  if(found.includes('appliance_repair') && !/\b(?:hvac|ac|air conditioner|air conditioning|furnace|heat pump|thermostat|duct)\b/.test(text)) return found.filter(key=>key!=='hvac');
  return found;
}
export function offeringTrade(service) {
  const category=canonicalTrade(service.category);
  if(category && !['general','other'].includes(category)) return category;
  const domains=detectServiceTrades(service.name);
  return domains.length===1 ? domains[0] : category;
}
export const isBroadOffering = service => {
  const name=normalize(service.name).replace(/\b(?:service|services|general|residential|commercial|repair|repairs|maintenance)\b/g,'').replace(/\s+/g,' ').trim();
  return canonicalTrade(name)===offeringTrade(service);
};
// An equipment family is narrower than a trade. A furnace must not match an AC
// offering; tree removal must not match lawn care, nor rekeying a lockout visit.
const subjects = [
 ['faucet',/\b(?:faucet|tap)\b/], ['toilet',/\btoilet\b/], ['sink',/\bsink\b/], ['tub',/\b(?:tub|bathtub)\b/], ['shower',/\bshower\b/], ['drain',/\bdrain\b/], ['water_heater',/\bwater heater\b/], ['pipe',/\bpipes?\b/],
 ['ac',/\b(?:ac|air condition(?:er|ing))\b/], ['furnace',/\bfurnace\b/], ['heat_pump',/\bheat pump\b/], ['duct',/\bduct(?:work)?\b/], ['thermostat',/\bthermostat\b/],
 ['roof',/\b(?:roof|roofing|shingles?)\b/], ['skylight',/\bskylight\b/], ['flashing',/\bflashing\b/],
 ['garage_door',/\bgarage doors?\b/], ['opener',/\b(?:garage )?opener\b/], ['spring',/\b(?:torsion )?springs?\b/],
 ['lawn',/\b(?:lawn|grass|mow(?:ing)?)\b/], ['tree',/\btrees?\b/], ['hedge',/\bhedges?\b/], ['irrigation',/\b(?:irrigation|sprinklers?)\b/], ['sod',/\bsod\b/],
 ['fridge',/\b(?:fridge|refrigerator)\b/], ['freezer',/\bfreezer\b/], ['washer',/\b(?:washer|washing machine)\b/], ['dryer',/\bdryer\b/], ['dishwasher',/\bdishwasher\b/], ['oven',/\b(?:oven|stove|cooktop)\b/], ['microwave',/\bmicrowave\b/],
 ['outlet',/\b(?:outlets?|receptacles?)\b/], ['breaker',/\bbreakers?\b/], ['panel',/\b(?:electrical )?panel\b/], ['switch',/\blight switch\b/],
 ['water_damage',/\b(?:water damage|water extraction|water mitigation|drying)\b/], ['mold',/\bmold\b/], ['fire_damage',/\b(?:fire|smoke) damage\b/],
 ['lockout',/\b(?:lockout|locked out)\b/], ['rekey',/\brekey(?:ing)?\b/], ['lock',/\b(?:door lock|deadbolt)\b/],
];
export const serviceSubjects = value => subjects.filter(([,pattern])=>pattern.test(normalize(value))).map(([key])=>key);
const workPatterns = {
 repair:/\b(?:repair|repairs|fix|fixing)\b/, installation:/\b(?:install|installation|installing|replacement|replace|replacing)\b/,
 inspection:/\b(?:inspect|inspection|assessment)\b/, maintenance:/\b(?:maintenance|tune up|servicing)\b/,
 removal:/\b(?:remove|removal)\b/, mowing:/\b(?:mow|mowing)\b/, trimming:/\b(?:trim|trimming|pruning)\b/,
};
export const requestedWork = value => Object.entries(workPatterns).filter(([,pattern])=>pattern.test(normalize(value))).map(([key])=>key);
export function hasMultipleEquipmentRequests(value) {
 if(!/\b(?:and|also)\b/i.test(value)) return false;
 const stated=serviceSubjects(value);
 // Restrict this rule to independent equipment. A dishwasher draining into a
 // sink, or a faucet attached to a sink, can describe one connected problem.
 return [ ['ac','furnace','heat_pump'], ['washer','dryer','dishwasher','oven','microwave','fridge'], ['lawn','tree','hedge','irrigation','sod'] ]
   .some(group=>stated.filter(key=>group.includes(key)).length>1);
}
export function semanticSubjectCompatible(raw, semantic) {
 const stated=serviceSubjects(raw), proposed=serviceSubjects(semantic);
 return !stated.length || proposed.every(key=>stated.includes(key));
}
export function operationCompatible(request, service) {
 const work=requestedWork(request), allowed=requestedWork(service.name);
 if(allowed.length && work.some(key=>!allowed.includes(key))) return false;
 const offered=normalize(service.name), text=normalize(request);
 if (/\b(?:home|residential|house)\b/.test(offered) && /\b(?:car|vehicle|truck|business|commercial|office)\b/.test(text)) return false;
 if (/\b(?:business|commercial)\b/.test(offered) && /\b(?:home|house|residential|car|vehicle|truck)\b/.test(text)) return false;
 if (/\b(?:car|vehicle|automotive)\b/.test(offered) && /\b(?:home|house|residential|business|office)\b/.test(text)) return false;
 return true;
}
export function capabilityMatch(request, service) {
  const offered=serviceSubjects(service.name), needed=serviceSubjects(request);
  if(!offered.length || !needed.length || !offered.every(key=>needed.includes(key))) return false;
  const work=requestedWork(request), allowed=requestedWork(service.name);
  // Do not infer permission for a different explicit operation. A broad service
  // with no operation constraint may still describe several types of work.
  if(allowed.length && work.some(key=>!allowed.includes(key))) return false;
  // A lawn-care offering covers mowing; it does not confer tree/irrigation work.
  if(offered.includes('lawn') && needed.some(key=>['tree','irrigation','sod'].includes(key))) return false;
  return true;
}
export const TRADE_CLARIFICATION = Object.freeze({
 plumbing:'What is happening—leaking or overflowing, a blockage, not operating, or something else?',
 hvac:'Which heating or cooling equipment needs attention, and what is happening?',
 roofing:'What roof damage have you noticed, and is water coming inside now?',
 electrical:'Is there no power, physical damage, heat, a burning smell, or sparking?',
 restoration:'What area is damaged, what caused it if known, and is the damage still spreading?',
 garage_door:'Is the door stuck open or closed, visibly damaged, or is the opener not responding?',
 locksmith:'Are you locked out, is the lock or key damaged, or do you need a lock changed?',
 landscaping:'What yard work do you need, and is this a one-time job or ongoing service?',
 appliance_repair:'Which appliance needs service, and what is happening with it?',
 other:'What equipment or part of the property needs attention, and what work would you like done?',
});
export function leakContext(value) {
 const text=normalize(value).replace(/\b(?:no|not|without)\s+(?:a\s+)?(?:refrigerant|freon|coolant|gas|propane|fuel|oil|chemical)(?:\s+leaks?)?\b/g,'');
 if(/\b(?:refrigerant|freon|coolant)\b/.test(text)) return 'refrigerant';
 if(/\b(?:(?:gas|propane|fuel|oil|chemical) leaks?|leak(?:ing|s)? (?:gas|propane|fuel|oil|chemical)|substance (?:gas|propane|fuel|oil|chemical))\b/.test(text)) return 'non_water';
 if(/\b(?:roof|roofing|shingle|skylight)\b/.test(text)) return 'roof';
 if(/\b(?:water damage|restoration|basement|ceiling)\b/.test(text)) return 'property';
 if(/\b(?:ac|air conditioner|air conditioning|heat pump|furnace|refrigerator|fridge|freezer)\b/.test(text) && !/\bwater\b/.test(text)) return 'unknown_fluid';
 return 'water';
}
export const tradeLeakQuestion = value => {
 const kind=leakContext(value);
 if(kind==='roof') return 'Is water coming inside now, only during rain, or has it stopped?';
 if(kind==='property') return 'Is water still coming in or spreading, or has it stopped?';
 if(kind==='refrigerant') return 'You reported a refrigerant leak. The team needs to assess this before scheduling; no appointment or response time is guaranteed.';
 if(kind==='non_water') return 'What substance is leaking? Do not touch it or attempt a repair. The team needs to review this request.';
 if(kind==='unknown_fluid') return 'Is the leak water, refrigerant or another substance, or are you unsure?';
 return '';
};
