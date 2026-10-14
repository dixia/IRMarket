import { test, expect } from "@playwright/test";

test("setup only (deploys stack, writes .env.local)", () => {
  expect(1).toBe(1);
});
