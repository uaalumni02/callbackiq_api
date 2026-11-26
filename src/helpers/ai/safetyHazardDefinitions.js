// Deterministic data shared by every trade and channel. No model authorizes safety routing.
export const SAFETY_HAZARD_PATTERN_GROUPS = [
  /*
   * Medical emergencies come first: when a message describes both a hazard
   * and a person in medical distress ("I smell gas and my wife passed out"),
   * "call 911 right away" is the most important instruction to send.
   */
  {
    type: "medical",
    patterns: [
      /\bmedical emergency\b/i,
      /\bdrown(?:ing|ed)\b/i,
      /\b(?:child|toddler|baby|pet|dog|cat|person|someone|i|we)\b[^.!?;]{0,50}\b(?:swallowed|ingested|drank|ate|exposed to)\b[^.!?;]{0,40}\b(?:rat poison|poison|pesticide|bleach|ammonia|cleaner|chemical)\b/i,
      /\b(?:mixed|mixing|combined|combining)\b[^.!?;]{0,45}\b(?:bleach|ammonia)\b[^.!?;]{0,35}\b(?:bleach|ammonia)\b/i,
      /\b(?:heart attack|stroke|seizure|allergic reaction|anaphylaxis)\b/i,
      /\b(?:not breathing|stopped breathing|can['\u2019]?t breathe|trouble breathing|difficulty breathing)\b/i,
      /\b(?:unconscious|unresponsive|passed out|fainted)\b/i,
      /\bchest pains?\b/i,
      /\bbleeding\b(?!\s+(?:the|a|air|valve)\b)/i,
      /\b(?:is|got|was|been|badly|seriously|severely) (?:hurt|injured)\b/i,
      /\binjur(?:ed|y|ies)\b/i,
      /\b(?:got|was|been|badly|severely) burn(?:ed|t)\b/i,
      /\bburn(?:ed|t) (?:himself|herself|myself|themselves|his|her|my)\b/i,
      /\b(?:ambulance|paramedics?|cpr)\b/i,
      /\boverdose\b/i,
      /\b(?:fell|fallen) (?:off|from|down) (?:the )?(?:ladder|roof|stairs)\b/i,
    ],
  },
  {
    type: "gas",
    patterns: [
      /\b(?:reeks?|reeking|stench)\b[^.!?;]{0,35}\b(?:natural )?gas\b/i,
      /\b(?:natural )?gas\s+(?:(?:is|keeps)\s+)?leak(?:ing|age|s)?\b/i,
      /\b(?:generator|charcoal grill|gas grill)\b[^.!?;]{0,35}\b(?:running|operating|on|used|using)\b[^.!?;]{0,20}\b(?:indoors|inside|in (?:the |my |our )?(?:house|home|garage|basement))\b/i,
      /\b(?:running|using)\b[^.!?;]{0,20}\b(?:generator|charcoal grill|gas grill)\b[^.!?;]{0,30}\b(?:indoors|inside|garage|basement)\b/i,

      /\b(?:smell|smells?|smelling|odor|odour) (?:of )?gas\b/i,
      /\bgas (?:leak|line leak|odor|odour|smell)\b/i,
      /\bpropane (?:leak|smell|odor|odour)\b/i,
      /\bsmells? like rotten eggs\b/i,
      /\brotten egg (?:smell|odor|odour)\b/i,
      /\bcarbon monoxide\b/i,
      /\bco (?:detector|alarm)\b[\s\S]*\b(?:alarm|beeping|going off|triggered)\b/i,
      /\bgas\b[\s\S]{0,60}\bhissing\b/i,
      /\bhissing\b[\s\S]{0,60}\bgas\b/i,
      /\b(?:gas|furnace|water heater|boiler|propane|tank)\b[\s\S]{0,60}\bexplo(?:de|ded|sion|ding)\b/i,
    ],
  },
  {
    type: "fire",
    patterns: [
      /\bsmells?\s+like\s+(?:(?:it|something|the (?:panel|dryer|oven|wiring))\s+)?(?:(?:is|was)\s+)?(?:burning|burned|burnt)\b/i,
      /\b(?:dryer|washer|oven|stove|microwave|appliance|furnace|air conditioner|heater)\b[^.!?;]{0,45}\b(?:smoking|on fire)\b/i,
      /\b(?:electrical|wiring|outlet|panel) (?:fire|smoke|burning)\b/i,
      /\b(?:smoke|fire|flames?)\b/i,
      /\b(?:burning|burned|burnt|electrical) smell\b/i,
      /\bsmells? (?:something )?(?:burning|burned|burnt)\b/i,
      /\b(?:outlet|wiring|panel|breaker)[^.!?;]{0,30}\bsmells?\s+(?:burned|burnt|burning)\b/i,
      /\bsomething(?:['\u2019]s| is) burning\b/i,
      /\bexplo(?:sion|ded|de|ding)\b/i,
    ],
  },
  {
    type: "electrical",
    patterns: [
      /\b(?:power|electric(?:al)?|live electric(?:al)?)\s+(?:cables?|wires?|lines?)\b[^.!?;]{0,60}\b(?:fallen|lying|on the ground|down)\b/i,
      /\b(?:tree|branch|branches|ladder)\b[^.!?;]{0,30}\b(?:touching|on|against|contact with)\s+(?:the |a |live )?(?:power|electric(?:al)?)\s+(?:lines?|wires?)\b/i,
      /\b(?:panel|breaker box|outlet|electrical equipment)\s+(?:is |are )?(?:underwater|submerged|covered in water)\b/i,

      /\b(?:electrical )?(?:sparking|arcing)\b/i,
      /\b(?:electrocuted|electric shock|got (?:shocked|zapped))\b/i,
      /\b(?:downed|fallen|live) (?:power line|electrical line|wire)\b/i,
      /\bpower line (?:is )?down\b/i,
      /\bexposed (?:live )?wir(?:e|es|ing)\b/i,
      /\b(?:outlet|wires?|wiring|panel|breaker) (?:is |are )?(?:smoking|melting|buzzing|sizzling|hot to the touch|warm to the touch|warm)\b/i,
      /\bwater\b[\s\S]{0,20}\b(?:near|on|in|into|onto|around|touching|leaking|dripping|pouring|coming)\b[\s\S]{0,20}\b(?:outlets?|panel|breaker|electrical|wires?|wiring|light fixture)\b/i,
    ],
  },
  {
    type: "structural",
    patterns: [
      /\b(?:ceiling|roof)\s+(?:is |has been |now )?(?:sagging|bulging|buckling)\b/i,
      /\b(?:garage door|tree)\s+(?:is |now )?(?:falling|hanging loose|about to fall)\b/i,

      /\b(?:ceiling|roof|walls?|floor|deck|porch|stairs|staircase|chimney|balcony)\b[\s\S]{0,25}\b(?:collaps(?:ed|ing)|caving|caved|giving way|fell in|falling (?:in|down))\b/i,
      /\b(?:ceiling|roof) (?:is )?falling\b(?! apart)/i,
      /\btree (?:fell|has fallen|came down|crashed|landed) (?:on|onto|into|through)\b/i,
      /\b(?:house|home|building|structure) (?:is )?(?:collapsing|unstable|shifting|caving)\b/i,
      /\bcaved? in\b/i,
      /\b(?:structural|roof) collapse\b/i,
    ],
  },
  {
    type: "trapped",
    patterns: [
      /\b(?:baby|child|toddler|pet|dog|cat)\b[^.!?;]{0,40}\b(?:in|inside)\b[^.!?;]{0,20}\b(?:locked|hot)\s+(?:car|vehicle|truck)\b/i,
      /\b(?:child|kid|baby|toddler|person|someone|somebody|he|she|they|i|we|pet|dog|cat)\s+(?:(?:is|are|am|got|was|were|has been)\s+)?(?:pinned|crushed|caught)\s+(?:under|underneath|beneath|in|by|between)\b/i,
      /\b(?:baby|toddler|kid|child|dog|cat|pet|person|someone)\s+(?:is |got |was |has been )?locked\s+(?:in|inside)\b/i,

      /\b(?:person|child|kid|baby|pet|dog|cat|someone|somebody|he|she|they|i['\u2019]?m|i am|we['\u2019]?re|we are) (?:is |are |am |got |get )?trapped\b/i,
      /(?<!\bair\s)\btrapped (?:in|under|underneath|inside|behind)\b/i,
      /\bstuck (?:under|inside|in the (?:elevator|bathroom|basement|attic|crawl ?space))\b/i,
      /\bchild (?:is )?locked (?:in|inside)\b/i,
    ],
  },
  {
    type: "flood",
    patterns: [
      /*
       * Active flooding, stated directly.
       */
      /\bactive flooding\b/i,
      /\bgushing water\b/i,
      // Escaping water is actionable even when the caller never says "flood".
      /\bwater\s+(?:(?:is|has been|now|still|currently|actively)\s+){0,3}(?:spilling|running|flowing|overflowing)\b[^.!?;]{0,35}\b(?:floor|carpet|room|hallway|stairs)\b/i,
      /\b(?:sink|toilet|tub|dishwasher|washer|water heater|pipe)\s+(?:(?:is|has been|now|still|currently|actively)\s+){0,3}(?:spilling|overflowing)\b/i,
      /\bwater\s+(?:(?:is|has been|now|still|currently|actively|just|keeps?)\s+){0,3}(?:pouring|gushing|flooding|spraying|shooting)\b/i,
      /\bflood(?:ing|ed)?\s+(?:my|our|the)\s+(?:house|home|basement|apartment|property|kitchen|bathroom|garage|floor)\b/i,
      /\b(?:house|home|basement|apartment|property|kitchen|bathroom|garage)\b[\s\S]*\b(?:is |are )?(?:flooding|flooded|under ?water)\b/i,

      /*
       * Imminent flooding: "it may flood my house", "going to flood".
       */
      /\b(?:may|might|could|going to|about to|gonna|starting to)\s+flood\b/i,

      /*
       * Fear or distress language paired with flooding.
       */
      /\b(?:scared|afraid|terrified|worried|concerned|panicking|panicked|emergency)\b[\s\S]*\bflood/i,

      /*
       * Escalating or uncontrolled water: "the water will not stop",
       * "water is spreading across the floor", "there's water everywhere".
       */
      /\b(?:water|leak|leaking)\b[\s\S]*\b(?:rising|spreading|getting worse|everywhere|won['\u2019]?t stop|will not stop|can['\u2019]?t stop)\b/i,

      /*
       * Burst plumbing.
       */
      /\bburst (?:pipe|water (?:line|main|heater))\b/i,
      /\b(?:pipe|water (?:line|main|heater))\b[\s\S]{0,40}\bburst(?:ed)?\b/i,
      /\bwater (?:coming|leaking|pouring|dripping) (?:through|from|out of|down) (?:the )?(?:ceiling|walls?|floor|light)\b/i,
    ],
  },
  {
    type: "sewage",
    patterns: [
      /\b(?:sewage|raw sewage|feces)\s+(?:is |now )?(?:coming|flowing|spilling|backing|rising)\b/i,
      /\b(?:sewage|sewer) (?:backup|overflow)\b/i,
    ],
  },
  {
    type: "temperature",
    patterns: [
      /\b(?:heat|heating|furnace|ac|a\/c|air conditioning|cooling)\s+(?:is |has )?(?:broken|failed|out|stopped working|not working)\b[^.!?;]{0,70}\b(?:infant|baby|newborn|elderly|extreme heat|freezing|medical)\b/i,
      /\b(?:oxygen concentrator|ventilator|life support)\b[^.!?;]{0,50}\b(?:lost power|no power|power is out|stopped working)\b/i,

      /\bno heat\b[\s\S]*\b(?:freezing|dangerously cold|below freezing|infant|baby|newborn|elderly|oxygen|medical)\b/i,
      /\b(?:freezing|dangerously cold|infant|baby|newborn|elderly|oxygen|medical condition)\b[\s\S]*\bno heat\b/i,
      /\bno (?:ac|a\/c|air conditioning|cooling)\b[\s\S]*\b(?:heat ?wave|extreme heat|dangerously hot|infant|baby|newborn|elderly|oxygen|medical)\b/i,
      /\b(?:heat ?wave|extreme heat|dangerously hot|infant|baby|newborn|elderly)\b[\s\S]*\bno (?:ac|a\/c|air conditioning|cooling)\b/i,
    ],
  },
  {
    type: "self_harm",
    patterns: [
      /\b(?:suicid(?:e|al)|want to die|kill myself|hurt myself|end my life|end it all)\b/i,
    ],
  },
  /*
   * Generic distress language. Deliberately last: a more specific hazard
   * type should win when both match, but a customer signaling "emergency"
   * or "call 911" always gets a safety response and a critical alert even
   * when no specific hazard was named.
   *
   * Note: a bare "911" is NOT matched on its own because street addresses
   * ("911 Main St") are a common false positive; call/dial phrasing is.
   */
  {
    type: "other",
    patterns: [
      /\b(?:someone|he|she|they|intruder)\b[^.!?;]{0,30}\b(?:threatening|attacking|breaking in)\b/i,
      /\b(?:call(?:ed|ing)?|dial(?:ed|ing)?) 911\b/i,
      /\b(?:this is|it['\u2019]?s|its|we (?:have|are having)|i (?:have|am having)|having) an emergency\b/i,
      /\bemergency situation\b/i,
      /\blife[- ]threatening\b/i,
      /\bin (?:immediate |serious |grave )?danger\b/i,
      /\bsomeone (?:could|might|will|is going to) (?:get hurt|die|be hurt)\b/i,
      /\bneed help (?:now|immediately|right away|asap|fast)\b/i,
      /\bsend help\b/i,
    ],
  },
];

export const HAZARDOUS_DIY_PATTERNS = [
  /\b(?:how (?:do|can|should) i|can i|help me)\s+(?:mix|combine|apply|spray|dilute)\b/i,
  /\bhow (?:do|can|should) i (?:fix|repair|replace|open|disconnect|rewire)\b/i,
  /\bwalk me through\b/i,
  /\b(?:how (?:do|can|should) i|can i|help me)\s+(?:bypass|disable|jump|adjust|release|recharge)\b/i,
  /\btell me how to\b/i,
];

export const HAZARDOUS_SYSTEM_PATTERNS = [
  /\b(?:bleach|ammonia|pesticides?|rat poison|pool chemicals?|chemical cleaner)\b/i,
  /\bgas (?:line|valve|furnace|water heater)\b/i,
  /\belectrical (?:panel|wiring|service|breaker)\b/i,
  /\bhigh voltage\b/i,
  /\b(?:garage(?: door)? (?:spring|cable)|torsion spring|safety sensor|refrigerant|live wire|breaker)\b/i,
  /\bcarbon monoxide\b/i,
  /\bcombustion\b/i,
  /\bstructural (?:damage|repair|wall|beam)\b/i,
];
