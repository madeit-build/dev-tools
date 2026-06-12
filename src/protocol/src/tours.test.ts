import { expect, test } from "vitest";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
} from "./index.js";

test("tour protocol constants are stable", () => {
  expect(LIST_TOURS_METHOD).toBe("hdtw/listTours");
  expect(GET_TOUR_METHOD).toBe("hdtw/getTour");
  expect(TOUR_NOT_FOUND_ERROR_CODE).toBe(-32001);
});
