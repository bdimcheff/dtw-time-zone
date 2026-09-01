import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, normalize } from "./match.ts";

/**
 * Cases are drawn from the real corpus wherever possible. The joke is retyped
 * from memory every time, so the matcher's job is to absorb spelling variation
 * without letting in sincere posts about time zones — which read almost
 * identically and are far more numerous.
 */

const exact = (t: string) => assert.equal(classify(t), "exact", t);
const variant = (t: string) => assert.equal(classify(t), "variant", t);
const ignore = (t: string) => assert.equal(classify(t), "ignore", t);

describe("normalize", () => {
  test("folds case, punctuation and whitespace to one form", () => {
    assert.equal(
      normalize("Detroit, Michigan   is in the\nEastern Time Zone!"),
      "detroit michigan is in the eastern time zone",
    );
  });

  test("strips accents rather than dropping the characters", () => {
    assert.equal(normalize("Détroit"), "detroit");
  });

  test("reduces emoji and symbols to separators, not to nothing", () => {
    // "🚨🗣️ DETROIT MICHIGAN IS IN THE EASTERN TIME ZONE🗣️🚨" is a real post;
    // collapsing the emoji away entirely would fuse it to the adjacent word.
    assert.equal(
      normalize("🚨🗣️DETROIT MICHIGAN IS IN THE EASTERN TIME ZONE🗣️🚨"),
      "detroit michigan is in the eastern time zone",
    );
  });

  test("leaves no leading or trailing padding", () => {
    assert.equal(normalize("  ...Detroit...  "), "detroit");
  });
});

describe("exact matches admit automatically", () => {
  test("the canonical phrase", () => {
    exact("Detroit, Michigan is in the Eastern Time Zone");
  });

  test("punctuation and casing vary freely", () => {
    exact("detroit michigan is in the eastern time zone");
    exact("Detroit Michigan is in the eastern time zone");
    exact("“Detroit, Michigan is in the Eastern Time Zone”");
    exact("DETROIT MICHIGAN IS IN THE EASTERN TIME ZONE");
  });

  test("the state may be abbreviated", () => {
    // Real posts; these were admitted by hand before the matcher accepted them.
    exact("Detroit, MI is in the Eastern Time Zone.");
    exact("Detroit, Mich. is in the Eastern Time Zone");
  });

  test("the phrase may be embedded in a longer post", () => {
    exact("hour 26: detroit michigan is in the eastern time zone");
    exact("🤔 I need to make a \"Detroit, Michigan is in the Eastern Time Zone\" feed");
    exact("Detroit, Michigan is in the Eastern Time Zone\n\nand it's 2025");
    exact("T-minus 9 days until I can say “Detroit, MI is in the Eastern time zone”");
  });
});

describe("variants go to the review queue", () => {
  test("the same construction applied to another Michigan city", () => {
    variant("Kalamazoo, Michigan, is in the Eastern Time Zone");
    variant("Kalamazoo, MI is in the Eastern Time Zone");
  });

  test("references to the announcement itself", () => {
    variant("*DTW announcer voice* Michigan is in the Eastern time zone");
    variant("Detroit is in the Eastern time zone. You probably heard this as you read it.");
    variant("Detroit is in the eastern time zone and the restrooms are “Determined To Wow”");
  });

  test("a local term without the full phrase", () => {
    variant("also, did you know Detroit is in the Eastern time zone?");
  });
});

describe("sincere posts are dropped, not queued", () => {
  test("other states that really are in the Eastern time zone", () => {
    ignore("The one that messes me up is that most of Indiana is in the eastern time zone.");
    ignore("we found out the hard way that South Bend is in the Eastern Time Zone and not Central");
    ignore("Now consider that Thunder Bay, Ontario is in the eastern time zone!");
  });

  test("the phrase used for its literal meaning", () => {
    ignore("I'm looking for somebody who is an AI expert who is in the eastern time zone only");
  });

  test("a place that is not in the announcement position", () => {
    // The shape gate keys on a place opening a clause, so these stay out even
    // though every other feature of the construction is present.
    ignore("I think Omaha, Nebraska is in the Central Time Zone");
    ignore("we found out that Boise is in the Mountain Time Zone");
  });

  test("a determiner or quantifier where the place would be", () => {
    // PLACE_STOP. The shape gate reads case-insensitively, so these are no
    // longer excluded by capitalization and each needs a real reason to fail.
    ignore("Most of Indiana is in the eastern time zone");
    ignore("Part of Oregon is in the mountain time zone");
    ignore("The midwest is in the eastern time zone apparently");
    ignore("My family is in the eastern time zone");
  });

  test("a time zone that is not one", () => {
    // Without the closed zone list, any word before "time zone" matches, and
    // these are the sincere shapes that produces.
    ignore("Denver is in the wrong time zone");
    ignore("Phoenix is in the same time zone as us right now");
  });

  test("text with no time zone phrase at all", () => {
    ignore("Only the real ones know");
    ignore("Detroit, Michigan");
  });
});

describe("the MI abbreviation does not match inside longer words", () => {
  /**
   * Local terms match on word boundaries. As a substring, "mi" appears in
   * "admit", "midwest" and "miles" — each of which shows up in exactly the kind
   * of sincere post the local-term gate exists to exclude, so substring matching
   * would have admitted them.
   */
  test("admit / midwest / miles do not count as a local term", () => {
    ignore("I admit that Indiana is in the eastern time zone");
    ignore("The midwest is in the eastern time zone apparently");
    ignore("It is 500 miles away and is in the eastern time zone");
    ignore("My family is in the eastern time zone");
  });

  test("but the standalone abbreviation still does", () => {
    variant("Ann Arbor, MI is in the Eastern Time Zone");
  });

  test("michigan is not matched by the mich abbreviation alternative", () => {
    // "mich" must not swallow "michigan" and change which branch fires.
    exact("Detroit, Michigan is in the Eastern Time Zone");
  });
});

describe("the announcement construction in another time zone", () => {
  /**
   * Issue #4. These are riffs on the original form, so they are queued for a
   * human and never auto-admitted — `classify` returns "variant", not "exact".
   *
   * Unlike every other rule here, the shape gate reads raw text: letter case
   * and clause position are the only things separating the joke from sincere
   * geography, and normalize() destroys both.
   */
  test("the place is swapped and so is the zone", () => {
    variant("Jackson Hole, Wyoming is in the Mountain Time Zone");
    variant("Omaha, Nebraska is in the Central Time Zone");
    variant("London, England is in the Greenwich Mean Time Zone");
    variant("Honolulu, Hawaii is in the Hawaii-Aleutian Time Zone");
  });

  test("the place may be a bare city, abbreviated, or carry a particle", () => {
    variant("Boise is in the Mountain Time Zone");
    variant("St. Louis, Missouri is in the Central Time Zone");
    // A capitalized-token run alone would break on the lowercase particle.
    variant("Coeur d\u2019Alene, Idaho is in the Pacific Time Zone");
    variant("Rio de Janeiro is in the Atlantic Time Zone");
  });

  test("the clause may open a sentence, a quotation or an aside", () => {
    variant("Fun fact. Omaha, Nebraska is in the Central Time Zone");
    variant("\u201cOmaha, Nebraska is in the Central Time Zone\u201d");
    variant("*airport voice* Omaha, Nebraska is in the Central Time Zone");
    variant("flight update:\nOmaha, Nebraska is in the Central Time Zone");
  });

  test("zone casing and the timezone spelling both vary", () => {
    variant("Boise, Idaho is in the Mountain time zone");
    variant("Boise, Idaho is in the Mountain timezone");
  });

  test("case is not a signal — a lowercase riff is queued too", () => {
    // The expensive half of the design. Reading raw text case-insensitively is
    // what makes PLACE_STOP necessary above; in exchange, a riff typed the way
    // most of them are typed reaches the queue instead of being dropped.
    variant("omaha nebraska is in the central time zone");
    variant("omaha, nebraska is in the central time zone");
    variant("salt lake city, utah is in the mountain time zone");
    variant("london england is in the greenwich mean time zone");
  });
});
