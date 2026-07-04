/**
 * Syllogism sprint template bank (DESIGN_V1.md §3.5). Pure data, zero Gemini:
 * 24 forms (12 valid, 12 invalid) × 60 term triples × 2 phrasings = 2,880
 * distinct rounds with DETERMINISTIC validity and hand-written explanations.
 *
 * Placeholders {A} {B} {C} are substituted from a term triple (plural nouns).
 * Every phrasing template is written to read naturally with bare plurals
 * ("All dalmatians are dogs", "This one is one of the dalmatians").
 *
 * The `valid` flags below are the ground truth the server scores against —
 * each is asserted one-by-one in tests/lib/syllogism.test.ts against a
 * hand-checked table. Edit with care.
 */

export interface Phrasing {
  premises: [string, string];
  conclusion: string;
}

export interface SyllogismForm {
  id: string;
  valid: boolean;
  phrasings: [Phrasing, Phrasing]; // 2 surface renderings per form
  explanation: string; // 1-2 sentence teach-back, fixed per form
}

export const FORMS: SyllogismForm[] = [
  // --- 12 VALID forms --------------------------------------------------------
  {
    id: "barbara",
    valid: true,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "All {B} are {C}."],
        conclusion: "All {A} are {C}.",
      },
      {
        premises: ["There are no {A} that are not {B}.", "There are no {B} that are not {C}."],
        conclusion: "There are no {A} that are not {C}.",
      },
    ],
    explanation:
      "Valid (Barbara). Membership chains through the middle group: every member of the first group is in the second, and every member of the second is in the third, so the first group sits entirely inside the third.",
  },
  {
    id: "celarent",
    valid: true,
    phrasings: [
      {
        premises: ["No {B} are {C}.", "All {A} are {B}."],
        conclusion: "No {A} are {C}.",
      },
      {
        premises: ["Not one of the {B} is one of the {C}.", "There are no {A} that are not {B}."],
        conclusion: "Not one of the {A} is one of the {C}.",
      },
    ],
    explanation:
      "Valid (Celarent). The first group sits entirely inside a group that is completely cut off from the third — so no member of the first group can be in the third.",
  },
  {
    id: "darii",
    valid: true,
    phrasings: [
      {
        premises: ["All {B} are {C}.", "Some {A} are {B}."],
        conclusion: "Some {A} are {C}.",
      },
      {
        premises: ["There are no {B} that are not {C}.", "There are {A} that are {B}."],
        conclusion: "There are {A} that are {C}.",
      },
    ],
    explanation:
      "Valid (Darii). The 'some' that belong to the middle group are carried along with it: everything in that middle group is in the conclusion's group, so those members qualify.",
  },
  {
    id: "ferio",
    valid: true,
    phrasings: [
      {
        premises: ["No {B} are {C}.", "Some {A} are {B}."],
        conclusion: "Some {A} are not {C}.",
      },
      {
        premises: ["Not one of the {B} is one of the {C}.", "There are {A} that are {B}."],
        conclusion: "There are {A} that are not {C}.",
      },
    ],
    explanation:
      "Valid (Ferio). The 'some' that belong to the middle group inherit its total exclusion from the third group — those members, at least, are not in it.",
  },
  {
    id: "modus_ponens",
    valid: true,
    phrasings: [
      {
        premises: [
          "If something is one of the {A}, then it is one of the {B}.",
          "This one is one of the {A}.",
        ],
        conclusion: "This one is one of the {B}.",
      },
      {
        premises: [
          "Anything that is one of the {A} is also one of the {B}.",
          "The item in question is one of the {A}.",
        ],
        conclusion: "The item in question is one of the {B}.",
      },
    ],
    explanation:
      "Valid (modus ponens). The rule says membership in the first group guarantees membership in the second; the premise confirms the first, so the second follows.",
  },
  {
    id: "modus_tollens",
    valid: true,
    phrasings: [
      {
        premises: [
          "If something is one of the {A}, then it is one of the {B}.",
          "This one is not one of the {B}.",
        ],
        conclusion: "This one is not one of the {A}.",
      },
      {
        premises: [
          "Anything that is one of the {A} is also one of the {B}.",
          "The item in question is not one of the {B}.",
        ],
        conclusion: "The item in question is not one of the {A}.",
      },
    ],
    explanation:
      "Valid (modus tollens). If being in the first group guaranteed being in the second, then lacking the second rules out the first.",
  },
  {
    id: "hypothetical_syllogism",
    valid: true,
    phrasings: [
      {
        premises: [
          "If something is one of the {A}, then it is one of the {B}.",
          "If something is one of the {B}, then it is one of the {C}.",
        ],
        conclusion: "If something is one of the {A}, then it is one of the {C}.",
      },
      {
        premises: [
          "Anything that is one of the {A} is also one of the {B}.",
          "Anything that is one of the {B} is also one of the {C}.",
        ],
        conclusion: "Anything that is one of the {A} is also one of the {C}.",
      },
    ],
    explanation:
      "Valid (hypothetical syllogism). Conditionals chain: the first guarantees the second, the second guarantees the third, so the first guarantees the third.",
  },
  {
    id: "disjunctive_syllogism",
    valid: true,
    phrasings: [
      {
        premises: [
          "This one is either one of the {A} or one of the {B}.",
          "It is not one of the {A}.",
        ],
        conclusion: "It is one of the {B}.",
      },
      {
        premises: [
          "The item in question is one of the {A} or one of the {B}, possibly both.",
          "It is not one of the {A}.",
        ],
        conclusion: "It is one of the {B}.",
      },
    ],
    explanation:
      "Valid (disjunctive syllogism). At least one of the two options must hold; eliminating one leaves the other.",
  },
  {
    id: "contraposition",
    valid: true,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "This one is not one of the {B}."],
        conclusion: "This one is not one of the {A}.",
      },
      {
        premises: [
          "There are no {A} that are not {B}.",
          "The item in question is not one of the {B}.",
        ],
        conclusion: "The item in question is not one of the {A}.",
      },
    ],
    explanation:
      "Valid (contraposition). 'All A are B' is equivalent to 'whatever is not a B is not an A' — the item lacks the second group's membership, so it cannot be in the first.",
  },
  {
    id: "ferio_variant",
    valid: true,
    phrasings: [
      {
        premises: ["No {A} are {B}.", "Some {C} are {A}."],
        conclusion: "Some {C} are not {B}.",
      },
      {
        premises: ["Not one of the {A} is one of the {B}.", "There are {C} that are {A}."],
        conclusion: "There are {C} that are not {B}.",
      },
    ],
    explanation:
      "Valid (Ferio variant). The first group is fully excluded from the second, so the 'some' of the third group that are in the first are, at minimum, outside the second.",
  },
  {
    id: "conversion_e",
    valid: true,
    phrasings: [
      {
        premises: ["No {A} are {B}.", "This one is one of the {B}."],
        conclusion: "This one is not one of the {A}.",
      },
      {
        premises: [
          "Not one of the {A} is one of the {B}.",
          "The item in question is one of the {B}.",
        ],
        conclusion: "The item in question is not one of the {A}.",
      },
    ],
    explanation:
      "Valid (E-conversion). 'No A are B' works in both directions — exclusion is symmetric. Being in the second group therefore rules out being in the first.",
  },
  {
    id: "conversion_i",
    valid: true,
    phrasings: [
      {
        premises: ["Some {A} are {B}.", "All {A} are {C}."],
        conclusion: "Some {C} are {B}.",
      },
      {
        premises: ["There are {A} that are {B}.", "There are no {A} that are not {C}."],
        conclusion: "There are {C} that are {B}.",
      },
    ],
    explanation:
      "Valid (I-conversion). The 'some' that are in both the first and second groups are also in the third (every member of the first is) — so some members of the third group are in the second.",
  },

  // --- 12 INVALID forms ------------------------------------------------------
  {
    id: "affirm_consequent",
    valid: false,
    phrasings: [
      {
        premises: [
          "If something is one of the {A}, then it is one of the {B}.",
          "This one is one of the {B}.",
        ],
        conclusion: "This one is one of the {A}.",
      },
      {
        premises: [
          "Anything that is one of the {A} is also one of the {B}.",
          "The item in question is one of the {B}.",
        ],
        conclusion: "The item in question is one of the {A}.",
      },
    ],
    explanation:
      "Invalid: affirming the consequent. The rule runs one way only — being in the second group doesn't prove membership in the first, because other things can be in the second group too.",
  },
  {
    id: "deny_antecedent",
    valid: false,
    phrasings: [
      {
        premises: [
          "If something is one of the {A}, then it is one of the {B}.",
          "This one is not one of the {A}.",
        ],
        conclusion: "This one is not one of the {B}.",
      },
      {
        premises: [
          "Anything that is one of the {A} is also one of the {B}.",
          "The item in question is not one of the {A}.",
        ],
        conclusion: "The item in question is not one of the {B}.",
      },
    ],
    explanation:
      "Invalid: denying the antecedent. Not being in the first group proves nothing about the second — things outside the first group may still be in the second.",
  },
  {
    id: "undistributed_middle",
    valid: false,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "All {C} are {B}."],
        conclusion: "All {A} are {C}.",
      },
      {
        premises: ["There are no {A} that are not {B}.", "There are no {C} that are not {B}."],
        conclusion: "There are no {A} that are not {C}.",
      },
    ],
    explanation:
      "Invalid: undistributed middle. Both groups sit inside the same larger group, but sharing a container doesn't connect them to each other.",
  },
  {
    id: "illicit_major",
    valid: false,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "No {C} are {A}."],
        conclusion: "No {C} are {B}.",
      },
      {
        premises: [
          "There are no {A} that are not {B}.",
          "Not one of the {C} is one of the {A}.",
        ],
        conclusion: "Not one of the {C} is one of the {B}.",
      },
    ],
    explanation:
      "Invalid: illicit major. Being cut off from the first group says nothing about the second — the second group can have members that never came through the first.",
  },
  {
    id: "illicit_minor",
    valid: false,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "All {A} are {C}."],
        conclusion: "All {C} are {B}.",
      },
      {
        premises: ["There are no {A} that are not {B}.", "There are no {A} that are not {C}."],
        conclusion: "There are no {C} that are not {B}.",
      },
    ],
    explanation:
      "Invalid: illicit minor. The premises put the first group inside both of the others; that doesn't make one of those larger groups fit inside the other.",
  },
  {
    id: "exclusive_premises",
    valid: false,
    phrasings: [
      {
        premises: ["No {A} are {B}.", "No {B} are {C}."],
        conclusion: "No {A} are {C}.",
      },
      {
        premises: [
          "Not one of the {A} is one of the {B}.",
          "Not one of the {B} is one of the {C}.",
        ],
        conclusion: "Not one of the {A} is one of the {C}.",
      },
    ],
    explanation:
      "Invalid: exclusive premises. Two negative premises establish no connection — the first and third groups may overlap completely or not at all.",
  },
  {
    id: "neg_premise_affirm_conclusion",
    valid: false,
    phrasings: [
      {
        premises: ["No {A} are {B}.", "Some {C} are {A}."],
        conclusion: "Some {C} are {B}.",
      },
      {
        premises: ["Not one of the {A} is one of the {B}.", "There are {C} that are {A}."],
        conclusion: "There are {C} that are {B}.",
      },
    ],
    explanation:
      "Invalid: affirmative conclusion from a negative premise. The premises show that some of the third group are OUTSIDE the second — they cannot show anything is inside it.",
  },
  {
    id: "existential_fallacy",
    valid: false,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "All {B} are {C}."],
        conclusion: "Some {A} are {C}.",
      },
      {
        premises: ["There are no {A} that are not {B}.", "There are no {B} that are not {C}."],
        conclusion: "There are {A} that are {C}.",
      },
    ],
    explanation:
      "Invalid: existential fallacy. 'All' statements don't guarantee anything exists, but 'some' asserts existence. If the first group is empty, both premises hold and the conclusion is false.",
  },
  {
    id: "illicit_conversion_a",
    valid: false,
    phrasings: [
      {
        premises: ["All {A} are {B}.", "This one is one of the {B}."],
        conclusion: "This one is one of the {A}.",
      },
      {
        premises: [
          "There are no {A} that are not {B}.",
          "The item in question is one of the {B}.",
        ],
        conclusion: "The item in question is one of the {A}.",
      },
    ],
    explanation:
      "Invalid: illicit conversion of 'all'. 'All A are B' doesn't reverse to 'all B are A' — the second group can be far bigger than the first.",
  },
  {
    id: "illicit_conversion_o",
    valid: false,
    phrasings: [
      {
        premises: ["Some {A} are not {B}.", "All {A} are {C}."],
        conclusion: "Some {B} are not {A}.",
      },
      {
        premises: ["There are {A} that are not {B}.", "There are no {A} that are not {C}."],
        conclusion: "There are {B} that are not {A}.",
      },
    ],
    explanation:
      "Invalid: illicit conversion of 'some are not'. Knowing some of the first group fall outside the second says nothing about whether any of the second group falls outside the first.",
  },
  {
    id: "affirm_disjunct",
    valid: false,
    phrasings: [
      {
        premises: [
          "This one is either one of the {A} or one of the {B}, possibly both.",
          "It is one of the {A}.",
        ],
        conclusion: "It is not one of the {B}.",
      },
      {
        premises: [
          "The item in question is one of the {A} or one of the {B}, or both.",
          "It is one of the {A}.",
        ],
        conclusion: "It is not one of the {B}.",
      },
    ],
    explanation:
      "Invalid: affirming a disjunct. An 'or' allows both options at once — confirming one does not rule out the other.",
  },
  {
    id: "some_for_all",
    valid: false,
    phrasings: [
      {
        premises: ["All {B} are {C}.", "Some {A} are {B}."],
        conclusion: "All {A} are {C}.",
      },
      {
        premises: ["There are no {B} that are not {C}.", "There are {A} that are {B}."],
        conclusion: "All of the {A} are {C}.",
      },
    ],
    explanation:
      "Invalid: the premises only license 'some'. The members that pass through the middle group qualify, but the rest of the first group is unaccounted for.",
  },
];

/**
 * 60 themed term triples (plural nouns). Domains: work/automation, cooking,
 * animals, sports, money — plus 10 deliberately implausible triples for
 * belief-bias resistance: validity must be judged on FORM, not plausibility.
 */
export const TERM_TRIPLES: [string, string, string][] = [
  // work / automation
  ["workflow builders", "toolmakers", "problem-solvers"],
  ["automation scripts", "scheduled jobs", "background tasks"],
  ["project managers", "planners", "deadline trackers"],
  ["webhooks", "triggers", "event listeners"],
  ["freelancers", "contractors", "self-employed workers"],
  ["code reviewers", "careful readers", "detail hunters"],
  ["chatbots", "software agents", "computer programs"],
  ["spreadsheets", "data files", "documents"],
  ["standup meetings", "team rituals", "recurring events"],
  ["bug reports", "tickets", "work items"],
  // cooking
  ["sourdough loaves", "breads", "baked goods"],
  ["chefs", "cooks", "kitchen workers"],
  ["stews", "slow-cooked dishes", "warm meals"],
  ["mangoes", "tropical fruits", "sweet foods"],
  ["cast-iron pans", "heavy pans", "kitchen tools"],
  ["espressos", "coffees", "caffeinated drinks"],
  ["dumplings", "wrapped foods", "snacks"],
  ["food critics", "tasters", "restaurant visitors"],
  ["chili peppers", "spicy ingredients", "strong flavors"],
  ["noodle soups", "broths", "comfort foods"],
  // animals
  ["dalmatians", "dogs", "mammals"],
  ["parrots", "birds", "egg-layers"],
  ["salmon", "fish", "swimmers"],
  ["honeybees", "insects", "pollinators"],
  ["tarsiers", "primates", "night creatures"],
  ["geckos", "lizards", "reptiles"],
  ["carabaos", "water buffalo", "farm animals"],
  ["whale sharks", "filter feeders", "ocean giants"],
  ["tabby cats", "cats", "hunters"],
  ["tree frogs", "amphibians", "climbers"],
  // sports
  ["point guards", "basketball players", "athletes"],
  ["marathoners", "runners", "endurance athletes"],
  ["southpaws", "boxers", "fighters"],
  ["goalkeepers", "football players", "team players"],
  ["black belts", "martial artists", "trained fighters"],
  ["sprinters", "track athletes", "fast movers"],
  ["setters", "volleyball players", "net players"],
  ["climbers", "mountaineers", "outdoor athletes"],
  ["chess grandmasters", "chess players", "strategists"],
  ["free divers", "divers", "breath-holders"],
  // money
  ["index funds", "investments", "financial assets"],
  ["budgeters", "spending planners", "careful savers"],
  ["landlords", "property owners", "rent collectors"],
  ["day traders", "market speculators", "risk takers"],
  ["emergency funds", "savings", "cash reserves"],
  ["invoices", "billing documents", "paperwork"],
  ["credit cards", "payment tools", "debt instruments"],
  ["pension plans", "retirement accounts", "long-term investments"],
  ["side hustles", "income streams", "money makers"],
  ["accountants", "number crunchers", "finance workers"],
  // deliberately implausible (belief-bias resistance)
  ["clouds", "accountants", "teaspoons"],
  ["volcanoes", "librarians", "umbrellas"],
  ["staplers", "penguins", "violins"],
  ["moons", "sandwiches", "bicycles"],
  ["cacti", "referees", "doorknobs"],
  ["glaciers", "poets", "toasters"],
  ["lighthouses", "hamsters", "calculators"],
  ["typhoons", "dentists", "pillows"],
  ["fossils", "baristas", "trampolines"],
  ["comets", "plumbers", "kettles"],
];
