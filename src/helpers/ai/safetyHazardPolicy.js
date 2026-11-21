import { cleanText } from "./guardrailText.js";

const SAFETY_HAZARD_PATTERN_GROUPS = [
  /*
   * Medical emergencies come first: when a message describes both a hazard
   * and a person in medical distress ("I smell gas and my wife passed out"),
   * "call 911 right away" is the most important instruction to send.
   */
  {
    type: "medical",
    patterns: [
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
      /\b(?:child|kid|baby|toddler|person|someone|somebody|he|she|they|i|we|pet|dog|cat)\s+(?:(?:is|are|am|got|was|were|has been)\s+)?(?:pinned|crushed|caught)\s+(?:under|beneath|in|by|between)\b/i,
      /\b(?:baby|toddler|kid|child|dog|cat|pet|person|someone)\s+(?:is |got |was |has been )?locked\s+(?:in|inside)\b/i,

      /\b(?:person|child|kid|baby|pet|dog|cat|someone|somebody|he|she|they|i['\u2019]?m|i am|we['\u2019]?re|we are) (?:is |are |am |got |get )?trapped\b/i,
      /(?<!\bair\s)\btrapped (?:in|under|inside|behind)\b/i,
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
/\b(?:sewage|sewer) (?:backup|overflow)\b/i],
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
  { type: "self_harm", patterns: [/\b(?:suicid(?:e|al)|want to die|kill myself|hurt myself|end my life|end it all)\b/i] },
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

const HAZARDOUS_DIY_PATTERNS = [
  /\bhow (?:do|can|should) i (?:fix|repair|replace|open|disconnect|rewire)\b/i,
  /\bwalk me through\b/i,
  /\b(?:how (?:do|can|should) i|can i|help me)\s+(?:bypass|disable|jump|adjust|release|recharge)\b/i,
  /\btell me how to\b/i,
];

const HAZARDOUS_SYSTEM_PATTERNS = [
  /\bgas (?:line|valve|furnace|water heater)\b/i,
  /\belectrical (?:panel|wiring|service|breaker)\b/i,
  /\bhigh voltage\b/i,
  /\b(?:garage(?: door)? (?:spring|cable)|torsion spring|safety sensor|refrigerant|live wire|breaker)\b/i,
  /\bcarbon monoxide\b/i,
  /\bcombustion\b/i,
  /\bstructural (?:damage|repair|wall|beam)\b/i,
];

const SAFETY_NEGATION_CUE =
  "(?:no|never|without|not|nothing|none|neither|nor|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|can['’]?t|couldn['’]?t|haven['’]?t|hasn['’]?t|hadn['’]?t|is not|are not|was not|were not|do not|does not|did not|cannot|could not|have not|has not|had not)";

/*
 * A negation cue governs the next few words, including a coordinated list:
 * "no leaking or flooding", "not flooded or anything", "nothing is flooded".
 */
const SAFETY_NEGATION_PREFIX = new RegExp(
  `(?:^|\\b)${SAFETY_NEGATION_CUE}\\b(?:[\\s,/]+[\\w'’]+){0,4}[\\s,/]*$`,
  "i",
);

const SAFETY_FALSE_NEGATION =
  /\bnot\s+(?:only|just)\b/i;

/*
 * Negation scope ends when the customer starts a new affirmative statement.
 * "My basement has no power and is flooded" is a flood. This list is
 * deliberately biased toward ending scope early: when scope is uncertain the
 * hazard stays affirmed (fail-safe).
 */
const SAFETY_NEGATION_SCOPE_END =
  /\b(?:now|still|then|so|because|since|when|while|until|after|and\s+(?:is|are|was|were|it|its|it['’]s|there|there['’]s|the|my|our|we|i|water|now|then|has|have))\b/i;

/*
 * These phrases contain a negation word that is part of the hazard itself
 * ("water won't stop", "can't shut it off", "not breathing").
 */
const SAFETY_HAZARD_BEARING_NEGATION =
  /\b(?:won['’]?t|will not|can['’]?t|cannot|can not|couldn['’]?t|could not|doesn['’]?t|does not|isn['’]?t|is not|not)\s+(?:[\w'’]+\s+){0,3}?(?:stop(?:ping)?|shut(?:ting)?|turn(?:ing)?|clos(?:e|ing)|breath(?:e|ing)|respon(?:d|ding|sive)|conscious|mov(?:e|ing)|get out|escape|drain(?:ing)?)\b/i;

/*
 * "No the kitchen is flooding" / "No, it's pouring" - a leading "no" that is
 * answering a question, followed by a new subject, is not a negation.
 */
const LEADING_ANSWER_NO =
  /^\s*(?:no|nope|nah)\b[\s,.!-]*(?=(?:the|my|our|it|its|it['’]s|i|i['’]m|we|we['’]re|there['’]s|there is|there are|actually)\b)/i;

const splitSafetyClauses = (text, preserveSubjectLinks = false) =>
  String(text || "")
    // A new subject + predicate ends the previous negation. Keep comma lists
    // ("no smoke, fire or sparks") together, but separate independent reports.
    .replace(/(?:,\s*|\band\s+)(?=(?:(?:the|my|our|your|his|her)\s+[a-z]+(?:\s+[a-z]+){0,2}|water|smoke|flames?|it|there|i|we|he|she|they)\s+(?:is|are|has|have|was|were|keeps?|comes?|pours?|flows?|smells?|started)\b)/gi, boundary => preserveSubjectLinks ? boundary : "; ")
    .split(
      /(?:[.!?;]+|,\s*(?=(?:just|actually|instead|rather)\b)|\b(?:but|however|although|though|yet|except)\b)/i,
    )
    .map((clause) => clause.replace(LEADING_ANSWER_NO, "").trim())
    .filter(Boolean);

const negationGovernsPosition = (clause, position) => {
  const prefix = clause.slice(Math.max(0, position - 90), position).trim();
  if (!prefix) return false;

  /*
   * "not only smoke..." and "not just smoke..." are affirmative mentions,
   * not safety negations.
   */
  if (SAFETY_FALSE_NEGATION.test(prefix.slice(-40))) return false;

  const cueMatch = SAFETY_NEGATION_PREFIX.exec(prefix);
  if (!cueMatch) return false;

  // Anything between the cue and the hazard that restarts an affirmative
  // statement ends the negation scope.
  return !SAFETY_NEGATION_SCOPE_END.test(cueMatch[0]);
};

/*
 * Some hazards ARE a negation: "no heat", "no AC", "no running water".
 * When the pattern itself spells out the negation word, a cue inside the
 * match is the hazard, not a denial of it.
 */
const patternCarriesNegation = (pattern) =>
  // Strip regex escapes first so "\\bno heat" is read as "no heat", not "bno".
  /(?:^|[^a-z])(?:no|not|without|never|nothing|none)(?:[^a-z]|$)/i.test(
    String(pattern?.source || "").replace(/\\[a-zA-Z]/g, " "),
  );

const isNegatedSafetyMatch = (clause, matchIndex, matchText = "", pattern = null) => {
  if (SAFETY_HAZARD_BEARING_NEGATION.test(matchText)) return false;

  // Negation stated before the whole matched phrase.
  if (negationGovernsPosition(clause, matchIndex)) return true;

  /*
   * Negation stated inside a wide match. Patterns such as
   * /kitchen ... flooding/ can begin far before the hazard word, so
   * "my kitchen sink is clogged there is no leaking or flooding" must be
   * evaluated at the hazard word, not at "kitchen".
   */
  const lastWord = /[\w'’]+\s*$/.exec(matchText);
  if (lastWord && lastWord.index > 0 && !patternCarriesNegation(pattern)) {
    return negationGovernsPosition(clause, matchIndex + lastWord.index);
  }
  return false;
};

export const patternHasAffirmedSafetyMatch = (pattern, text) => {
  for (const clause of splitSafetyClauses(text, patternCarriesNegation(pattern))) {
    /*
     * Clone the expression so global/sticky lastIndex state can never leak
     * between calls. Use global matching so a negated first occurrence does
     * not hide a later affirmative occurrence in the same clause.
     */
    const flags = Array.from(
      new Set(
        `${pattern.flags.replace(/[gy]/g, "")}g`
          .split(""),
      ),
    ).join("");

    const matcher = new RegExp(pattern.source, flags);

    let match;

    while ((match = matcher.exec(clause)) !== null) {
      const internallyNegated = /\b(?:is not|are not|isn[’']?t|aren[’']?t|not currently|no longer)\b/i.test(match[0]);
      if (!internallyNegated && !isNegatedSafetyMatch(clause, match.index, match[0], pattern)) {
        return true;
      }

      // Defensive guard for any zero-length expression.
      if (match[0] === "") {
        matcher.lastIndex += 1;
      }
    }
  }

  return false;
};

/*
 * Safety state is about current danger, not a bag of keywords. Normalize the
 * small amount of cross-clause discourse that deterministic patterns cannot
 * infer on their own: historical hazards are not active unless the customer
 * says they remain current, while "now it is" can affirm a previously named
 * hazard even when the noun is omitted.
 */
const SAFETY_REFERENCE_GROUPS = [
  { type: "medical", pattern: /\b(?:heart attack|stroke|seizure|unconscious|unresponsive|passed out|not breathing|trouble breathing|injured|bleeding)\b/i, canonical: "medical emergency" },
  { type: "gas", pattern: /\b(?:gas|propane|carbon monoxide|rotten eggs?)\b/i, canonical: "smell gas" },
  { type: "fire", pattern: /\b(?:smoke|smoking|fire|flames?|burning|burned smell|burnt smell)\b/i, canonical: "smoke" },
  { type: "electrical", pattern: /\b(?:sparks?|sparking|arcing|live wire|electrical shock)\b/i, canonical: "electrical sparking" },
  { type: "structural", pattern: /\b(?:collapse|collapsing|sagging|bulging|caving|unstable)\b/i, canonical: "structural collapse" },
  { type: "trapped", pattern: /\b(?:trapped|pinned|crushed|caught under|locked inside|stuck inside)\b/i, canonical: "person trapped" },
  { type: "flood", pattern: /\b(?:flood(?:ed|ing)?|gushing water|burst pipe|water pouring|water spreading|uncontrolled water)\b/i, canonical: "active flooding" },
  { type: "sewage", pattern: /\b(?:sewage|sewer backup|sewer overflow)\b/i, canonical: "sewage backup" },
];

// Past-tense grammar alone does not establish that danger has ended (for
// example, 'the technician was injured' or 'a child was trapped').
const HISTORICAL_SAFETY_TIME = /\b(?:earlier|before|previously|yesterday|last (?:night|week|month|year)|years? ago|used to)\b/i;
const CURRENT_SAFETY_TIME = /\b(?:now|still|again|currently|right now|today|at the moment)\b/i;
const CURRENT_RESOLUTION = /\b(?:there (?:is|are) none|there isn['’]?t any|none now|no longer|not anymore|not now|has stopped|have stopped|stopped|is gone|are gone|cleared|resolved|fixed|all clear|safe now)\b/i;
const ANAPHORIC_CURRENT_AFFIRMATION = /(?:\b(?:now|still|currently|right now)\s+(?:(?:it|that|this)\s+(?:is|isn['’]?t|has|hasn['’]?t)|there\s+(?:is|are))\b|\b(?:i|we)\s+(?:still|currently)\s+(?:smell|see|hear|feel)\s+(?:it|that)\b|\b(?:still|currently)\s+(?:smell|see|hear|feel)\s+(?:it|that)\b)(?![^.!?;]{0,18}\b(?:none|no longer|not|gone|stopped|resolved|fixed|clear|safe)\b)/i;

const normalizeSafetyDiscourse = (value) => {
  const segments = cleanText(value)
    .split(/(?:[.!?;]+|\b(?:but|however|although|though|yet)\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  let lastReference = null;
  return segments.map((segment, index) => {
    const reference = SAFETY_REFERENCE_GROUPS.find(({ pattern }) => pattern.test(segment));
    if (reference) lastReference = reference;

    const historical = HISTORICAL_SAFETY_TIME.test(segment);
    const current = CURRENT_SAFETY_TIME.test(segment);
    // A clear resolution in the next clause can refer back to the hazard:
    // "There was smoke, but there is none now." Bare past tense alone cannot.
    const next = segments[index + 1] || '';
    const resolvedNext = /^(?:there (?:is|are) none(?: now)?|there isn['’]?t any(?: now)?|(?:it|that) (?:has stopped|is gone|is resolved|is fixed))(?:[,. ]*)$/i.test(next);
    if (reference && !current && resolvedNext) return "resolved condition";

    if (reference && historical && !current) {
      // Preserve the referent for later anaphora, but do not treat a clearly
      // historical observation as a current emergency by itself.
      return "historical condition";
    }

    if (lastReference && CURRENT_RESOLUTION.test(segment)) {
      return "resolved condition";
    }

    if (!reference && lastReference && ANAPHORIC_CURRENT_AFFIRMATION.test(segment)) {
      return `${lastReference.canonical} ${segment}`;
    }

    return segment;
  }).join('; ');
};

/*
 * Returns the hazard type ("gas", "fire", "electrical", "flood", "sewage",
 * "other") when the message describes a safety hazard, or an empty string
 * when it does not. The first matching group wins, and groups are ordered by
 * severity so gas and fire outrank flooding when a message mentions both.
 */
// Extract the urgent repair clause independently of logistics. Additional
// danger evidence always defeats this exception, even in an address-bearing turn.
export const isUrgentPlumbingRequest = value => {
  const text = String(value || '').trim();
  const match = text.match(/^(?:(?:hi[,!]?|help[,!]?)\s+)?(?:(?:my|our|the|a)\s+)?(?:(?:kitchen |bathroom )?(?:toilet|sink|tub|washer|dishwasher)(?: is|'s)? (?:overflowing|spilling)|(?:water )?pipe (?:has |just |has just )?burst|burst (?:water )?pipe)\b/i);
  if (!match) return false;
  const remainder = text.slice(match[0].length).trim();
  if (!remainder || /^[.! ]*$/.test(remainder)) return true;
  if (SAFETY_HAZARD_PATTERN_GROUPS.some(group => group.patterns.some(pattern => patternHasAffirmedSafetyMatch(pattern, remainder)))) return false;
  if (/\b(?:can't|cannot|unable to)\s+(?:stop|shut|turn)\b/i.test(remainder)) return false;
  if (/\b(?:floor|electri(?:c|cal)|outlet|danger|injur|trapped|uncontrolled|sewage|spreading|ceiling|sparks?|smoke|gas)\b/i.test(remainder)) return false;
  // Only logistics can be appended here. Uninterpreted condition clauses stay
  // in the safety path rather than silently downgrading possible danger.
  return /^(?:[.,;]\s*)?(?:at\s+\d+[a-z]?|my address is\s+\d+[a-z]?|the address is\s+\d+[a-z]?|please (?:call|help)|can you (?:call|help)|call me|asap|today|tomorrow)\b/i.test(remainder);
};

export const detectSafetyHazardType = (value) => {
  const text = normalizeSafetyDiscourse(value);

  if (!text) {
    return "";
  }

  // A request to install safety equipment is not itself an active hazard.
  // Mask only that equipment noun, keeping any subsequent hazard intact.
  const hazardText = text.replace(
    /\b((?:install|replace|test|inspect|service|repair)(?:ing|ment|ation)?\s+(?:(?:a|an|the|my|our|new|old|existing)\s+){0,3})(?:smoke|carbon monoxide|co|fire)\s+(?:detectors?|alarms?)\b(?![^.!?;]{0,35}\b(?:going off|triggered|sounding|beeping)\b)/gi,
    "$1safety equipment",
  ).replace(/\b(?:smoke|fire|carbon monoxide|co)\s+(?:detectors?|alarms?)\b(?![^.!?;]{0,25}\b(?:going off|triggered|sounding|beeping)\b)/gi, "safety equipment")
    .replace(/\b(?:fire pit|fireplace|smoke test|smoke testing|fire damage restoration)\b/gi, "equipment service");
  const matchedGroup = SAFETY_HAZARD_PATTERN_GROUPS.find((group) =>
    group.patterns.some((pattern) =>
      patternHasAffirmedSafetyMatch(pattern, hazardText),
    ),
  );

  if (matchedGroup?.type === "flood" && isUrgentPlumbingRequest(text)) return "";
  return matchedGroup ? matchedGroup.type : "";
};

const SAFETY_QUESTION = "Is anyone in immediate danger, or is there smoke, a gas smell, sparking, or uncontrolled water right now?";
const SAFETY_CLARIFICATION_REPLY = `${SAFETY_QUESTION} If yes, contact 911 or the utility emergency line from a safe location; do not wait here. This service does not monitor emergencies or dispatch emergency help.`;

export const assessSafetyContext = ({ customerMessage, recentMessages = [], activityWindowStartAt = null }) => {
  const text = cleanText(customerMessage);
  const direct = detectSafetyHazardType(text);
  if (direct) return { hazardType: direct };
  const start = activityWindowStartAt ? new Date(activityWindowStartAt).getTime() : 0;
  const now = Date.now();
  const history = recentMessages.filter(m => {
    if ([m.status, m.deliveryStatus].some(v => ["suppressed", "failed", "undelivered"].includes(v))) return false;
    const at = new Date(m.createdAt || m.at || 0).getTime();
    return at >= Math.max(start || 0, now - 30 * 60 * 1000) && at <= now + 60 * 1000;
  }).slice(-6);
  const body = m => cleanText(m?.body || m?.text);
  if (history.at(-1)?.direction === "inbound" && body(history.at(-1)) === text) history.pop();
  const last = history.at(-1);
  const affirmative = /^(?:yes|yeah|yep|correct|it is|there is|still happening)[.! ]*$/i.test(text);
  if (affirmative && last?.direction === "outbound" && body(last).startsWith(SAFETY_QUESTION)) {
    return { hazardType: "other" };
  }
  const worsening = /^(?:yes[, ]+)?(?:it(?:'s| is)|things? (?:is|are)) (?:getting worse|worse|still happening|spreading|getting bigger)[.! ]*$/i.test(text);
  if (worsening) {
    const previous = [...history].reverse().find(m => m.direction === "inbound" && body(m) !== text);
    const hazard = previous && detectSafetyHazardType(body(previous));
    if (hazard) return { hazardType: hazard };
  }
  const uncertain = patternHasAffirmedSafetyMatch(/\b(?:strange|weird|unusual) (?:smell|odor)|\b(?:alarm|detector) (?:is )?(?:beeping|going off|sounding)|\b(?:something|there) (?:just )?(?:burst|exploded)|\bheard (?:a )?loud bang\b/i, text);
  // An ambiguous report does not establish an emergency or diagnose the cause.
  const answeringSafetyQuestion = last?.direction === "outbound" && body(last).startsWith(SAFETY_QUESTION);
  const cannotClarify = answeringSafetyQuestion && /^(?:not sure|i (?:do not|don't) know|maybe|unsure)[.! ]*$/i.test(text);
  if (uncertain || worsening || cannotClarify) return { hazardType: "", needsClarification: true,
    reply: answeringSafetyQuestion
      ? "I cannot determine whether this is safe. Contact a qualified professional; for immediate danger, call 911 or the utility emergency line from a safe location. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback."
      : SAFETY_CLARIFICATION_REPLY };
  return { hazardType: "" };
};

export const containsSafetyHazard = (value) => {
  return detectSafetyHazardType(value) !== "";
};

export const containsHazardousDIYRequest = (value) => {
  const text = cleanText(value);

  const requestsInstructions = HAZARDOUS_DIY_PATTERNS.some((pattern) =>
    pattern.test(text),
  );

  const concernsHazardousSystem = HAZARDOUS_SYSTEM_PATTERNS.some((pattern) =>
    pattern.test(text),
  );

  return requestsInstructions && concernsHazardousSystem;
};
