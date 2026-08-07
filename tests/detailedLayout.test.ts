import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAILED_ANSWER_MAX_HEIGHT,
  DETAILED_ANSWER_MIN_HEIGHT,
  detailedAnswerPanelHeight,
} from "../src/detailedLayout.ts";

test("a rövid VÁLASZ panel megtartja a kompakt alapmélységet", () => {
  assert.equal(detailedAnswerPanelHeight(36, 56), DETAILED_ANSWER_MIN_HEIGHT);
});

test("a VÁLASZ panel a közepes tartalommal együtt nő", () => {
  assert.equal(detailedAnswerPanelHeight(164, 56), 220);
});

test("a hosszú VÁLASZ panel a korábbi maximumon görgetni kezd", () => {
  assert.equal(detailedAnswerPanelHeight(900, 56), DETAILED_ANSWER_MAX_HEIGHT);
});
