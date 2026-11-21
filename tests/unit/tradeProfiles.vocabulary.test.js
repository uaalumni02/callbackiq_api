import { detectServiceTrades, serviceSubjects, capabilityMatch, leakContext } from '../../src/services/trades/tradeProfiles.service.js';

test.each([
 ['plumbing',['toilets','drains','pipes','water heaters','clogged','backed up','garbage disposals','water softeners','well pumps','main lines','gas lines','tankless','kitchen leaking','bathroom leak','basement leaks','ceiling leaking','water leak']],
 ['hvac',['ducts','boilers','mini splits','heaters','condensers','compressors','air handlers','no heat','no cooling','AC units','ACs','furnance']],
 ['electrical',['flickering lights','GFCI','tripping','generators','EV chargers','ceiling fans','sparks','power out','lights out','light switches']],
 ['roofing',['gutters','hail','storm damage','missing shingles','skylights']],
])('%s recognizes expanded vocabulary',(trade,phrases)=>{
 for(const phrase of phrases) expect({phrase,trades:detectServiceTrades(phrase)}).toEqual({phrase,trades:[trade]});
});
test.each([
 ['water heater leaking',['plumbing']],['water heaters leaking',['plumbing']],['roof leak into the ceiling',['roofing']],['ceiling leaking after rain',['roofing']],['skylights leaking',['roofing']],['my car AC is broken',[]],['my car AC compressor is broken',[]],['my fridge compressor is broken',['appliance_repair']],['fridges have no cooling',['appliance_repair']],['water heater and furnace repair',['plumbing','hvac']],
])('trade precedence: %s',(text,expected)=>expect(detectServiceTrades(text)).toEqual(expected));
test.each([
 ['disposal','garbage disposals','Garbage disposal repair'],['boiler','boilers','Boiler repair'],['mini_split','mini splits','Mini-split repair'],['generator','generators','Generator repair'],['ev_charger','EV chargers','EV charger repair'],['gutter','gutters','Gutter repair'],['water_softener','water softeners','Water softener repair'],['well_pump','well pumps','Well pump repair'],['main_line','sewers','Sewer/main line clog'],['air_handler','air handlers','Air handler repair'],['ceiling_fan','ceiling fans','Ceiling fan repair'],
])('%s equipment supports owner catalog matching',(subject,request,name)=>{
 expect(serviceSubjects(request)).toContain(subject);expect(capabilityMatch(`fix my ${request}`,{name})).toBe(true);
});
test.each([['roof leak','roof'],['AC leaking','unknown_fluid'],['water heater leaking','water'],['ceiling leaking','property'],['gas leak','non_water'],['refrigerant leaking','refrigerant']])('preserves leak context: %s',(text,expected)=>expect(leakContext(text)).toBe(expected));
