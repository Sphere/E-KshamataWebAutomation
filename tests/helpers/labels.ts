/**
 * Button labels, in both languages the portal ships.
 * ─────────────────────────────────────────────────
 * Hindi is NOT a word-for-word translation, and matching it as if it were is
 * what breaks these clicks. Two traps, both seen live on the portal:
 *
 *   1. The WORD ORDER flips. "Start Self Assessment" is rendered
 *      "शुरू करें स्वयं मूल्यांकन" — literally "start (करें) self assessment".
 *      A pattern like /स्वयं\s*मूल्यांकन\s*शुरू/ never matches it.
 *   2. The label carries EXTRA words. The card reads "कोर्स शुरू करें", so an
 *      anchored /^(…|शुरू करें|…)$/ matches nothing — which is exactly why
 *      "Start Learning" was reported as "did not click". English has the same
 *      problem: "Start Again" on a completed course's TOC failed /^start$/.
 *
 * So: match a DISTINCTIVE FRAGMENT anywhere in the label, never the whole
 * string, and never assume the Hindi words sit in the English order.
 */

/**
 * Enter or continue a course — the TOC's primary action and the card's
 * "Start Learning" after a failed level.
 *
 * English: Start, Start Learning, Start Course, Start Again, Start Now,
 *          Resume, Continue.
 * Hindi:   कोर्स शुरू करें, सीखना शुरू करें, पढ़ना आरंभ करें, अभी शुरू करें,
 *          जारी रखें, फिर से शुरू करें, पाठ्यक्रम शुरू करें.
 */
export const START_COURSE =
  /start(\s+(learning|course|again|now))?\b|resume|continue|कोर्स\s*(शुरू|आरंभ)|पाठ्यक्रम\s*(शुरू|आरंभ)|सीखना\s*(शुरू|आरंभ)|पढ़ना\s*(शुरू|आरंभ)|अभी\s*शुरू|जारी\s*रख|फिर\s*से\s*शुरू/i;

/**
 * Begin the competency self-assessment — the competency card's button while a
 * level is still unattempted. Both word orders, because Hindi flips them.
 */
export const START_SELF_ASSESSMENT =
  /start\s+self\s+assessment|self\s+assessment|स्वयं\s*मूल्यांकन|मूल्यांकन\s*शुरू|शुरू\s*करें\s*स्वयं/i;

/**
 * "Start Level N" on a passing result.
 *
 * The portal uses BOTH Hindi words for "level" — a card's stepper is labelled
 * "स्तर:" while the note right under it reads "लेवल 1" — so a pattern that
 * knows only one of them stops the climb at whichever screen uses the other.
 */
export const START_LEVEL =
  /start(\s+next)?\s+level|next\s+level|(लेवल|स्तर)\s*\d*\s*(का\s*)?(कोर्स|पाठ्यक्रम)?\s*(शुरू|आरंभ)|अगला\s*(लेवल|स्तर)/i;

/** The player's "Next" between modules. */
export const NEXT = /^(next|अगला|आगे)$/i;

/** True when `text` carries any of `re` — whitespace-collapsed, trimmed. */
export function labelMatches(text: string | null | undefined, re: RegExp): boolean {
  return re.test((text ?? '').replace(/\s+/g, ' ').trim());
}

/**
 * "Go back to home" on a result popup — Hindi: "होम स्क्रीन पर वापस जाएं"
 * (captured live; an English-only match left the popup open).
 */
export const GO_HOME = /go\s*back\s*to\s*home|होम\s*(स्क्रीन\s*)?(पर\s*)?वापस|होम\s*स्क्रीन/i;

/**
 * "Congratulations! Competency Achieved" — the popup that ends a competency.
 *
 * Matching this in English only is worse than cosmetic: the fail-then-course
 * run uses it to decide whether the competency is finished, so on a Hindi
 * portal it kept looking for levels that were already done. The Hindi wording
 * pairs योग्यता/दक्षता with प्राप्त/हासिल/पूर्ण — the second word is required,
 * because "योग्यता" alone is the label on every competency card.
 */
export const COMPETENCY_ACHIEVED =
  /competency\s+achieved|(योग्यता|दक्षता)\s*(की\s*)?(प्राप्त|हासिल|पूर्ण|पूरी)/i;

/**
 * "Start Now!" on a quiz intro — English, or Hindi "अभी शुरू करें".
 *
 * The bare "शुरू करें" ending has to stay in the pattern (builds render the
 * button with and without "अभी"), which makes it dangerously generic: see
 * DISCUSSION below.
 */
export const START_NOW = /start\s*now|अभी\s*शुरू|शुरू\s*करें/i;

/**
 * Controls that belong to the DISCUSSION widget, never to the assessment.
 *
 * The result and quiz screens embed a discussion box whose button reads
 * "बातचीत शुरू करें" — "start a conversation". It ends in "शुरू करें" exactly
 * like the assessment's own "अभी शुरू करें", so a generic start matcher picks
 * it and the run opens the discussion form instead of the quiz. Anything
 * matching this is excluded from a start click, in every language.
 */
export const DISCUSSION =
  /बातचीत|चर्चा|टिप्पणी|पोस्ट\s*सबमिट|त्यागना|discussion|comment|post\s*submit|discard/i;
