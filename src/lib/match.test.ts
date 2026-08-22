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
