// Each offering is owner-approved in this test fixture, never provisioned in production.
export const multiTradeCases = [
 {trade:'plumbing',name:'Faucet repair',request:'My faucet is leaking',answers:['Only when I use it']},
 {trade:'hvac',name:'AC repair',request:'My AC is not cooling',answers:[]},
 {trade:'roofing',name:'Roof repair',request:'My roof is leaking',answers:['Only during rain']},
 {trade:'electrical',name:'Outlet repair',request:'My outlet has no power',answers:['Only one outlet']},
 {trade:'restoration',name:'Water damage assessment',request:'I need a water damage assessment',answers:['The source is stopped']},
 {trade:'garage_door',name:'Garage door repair',request:'My garage door spring snapped',answers:['The door is closed']},
 {trade:'locksmith',name:'Home lockout',request:'I am locked out of my home',answers:[]},
 {trade:'landscaping',name:'Lawn mowing',request:'I need lawn mowing',answers:['One-time service']},
 {trade:'appliance_repair',name:'Refrigerator repair',request:'My fridge is not cooling',answers:[]},
 {trade:'other',name:'Fence repair',request:'I need fence repair',answers:[]},
];
export const testOffering = row => ({_id:'s1',name:row.name,category:'general',active:true,aiCanDiscuss:true,aiCanBook:true,durationMinutes:90,keywords:[],excludedKeywords:[]});
