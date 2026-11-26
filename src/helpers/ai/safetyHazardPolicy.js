import {SAFETY_HAZARD_PATTERN_GROUPS,HAZARDOUS_DIY_PATTERNS,HAZARDOUS_SYSTEM_PATTERNS} from './safetyHazardDefinitions.js';
import {normalizeSafetyLanguage} from './safetyLanguage.js';
import { cleanText } from "./guardrailText.js";

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
  { type: "medical", pattern: /\b(?:poison|swallowed|bleach|ammonia|drown|heart attack|stroke|seizure|unconscious|unresponsive|passed out|not breathing|trouble breathing|injured|bleeding)\b/i, canonical: "medical emergency" },
  { type: "gas", pattern: /\b(?:gas|propane|carbon monoxide|rotten eggs?)\b/i, canonical: "smell gas" },
  { type: "fire", pattern: /\b(?:smoke|smoking|fire|flames?|burning|burned smell|burnt smell)\b/i, canonical: "smoke" },
  { type: "electrical", pattern: /\b(?:power cable|electric(?:al)? cable|sparks?|sparking|arcing|live wire|electrical shock)\b/i, canonical: "electrical sparking" },
  { type: "structural", pattern: /\b(?:collapse|collapsing|sagging|bulging|caving|unstable)\b/i, canonical: "structural collapse" },
  { type: "trapped", pattern: /\b(?:trapped|pinned|crushed|caught under|locked inside|locked car|stuck inside)\b/i, canonical: "person trapped" },
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
  const segments = normalizeSafetyLanguage(cleanText(value))
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
