import assert from "node:assert/strict";
import { calculateReorderForecast } from "../artifacts/api-server/src/lib/reorder-forecast";

const baseEvidence = {
  productId: 1,
  productName: "Test Chemical",
  unit: "gallons",
  unitCost: 4,
  reorderPoint: 10,
  targetLevel: 30,
  currentStock: 12,
  receivingRecordCount: 1,
};

const sample = (usage: number, received: number, basisDays = 5) => ({
  usage,
  received,
  basisDays,
  finalizedAt: "2026-09-23T00:00:00.000Z",
});

const normal = calculateReorderForecast({
  ...baseEvidence,
  samples: [sample(10, 2), sample(8, 1)],
});
assert.equal(normal.status, "calculated");
assert.equal(normal.inputs.verifiedSnapshotCount, 2);
assert.equal(normal.inputs.basisDays, 10);
assert.equal(normal.inputs.totalUsage, 18);
assert.equal(normal.inputs.receivedDuringBasis, 3);
assert.equal(normal.consumptionRatePerDay, 1.8);
assert.equal(normal.daysUntilReorder, 1.111);
assert.equal(normal.suggestedQuantity, 18);

const sparse = calculateReorderForecast({
  ...baseEvidence,
  samples: [sample(10, 2)],
});
assert.equal(sparse.status, "partial");
assert.equal(sparse.consumptionRatePerDay, 2);
assert.equal("daysUntilReorder" in sparse, false);
assert.equal("suggestedQuantity" in sparse, false);

const zeroUsage = calculateReorderForecast({
  ...baseEvidence,
  samples: [sample(0, 5), sample(0, 0)],
});
assert.equal(zeroUsage.status, "unavailable");
assert.equal(zeroUsage.consumptionRatePerDay, 0);
assert.equal("daysOfSupply" in zeroUsage, false);
assert.equal("suggestedQuantity" in zeroUsage, false);

const receivingActivity = calculateReorderForecast({
  ...baseEvidence,
  samples: [sample(6, 10), sample(4, 8)],
});
assert.equal(receivingActivity.status, "calculated");
assert.equal(receivingActivity.inputs.totalUsage, 10);
assert.equal(receivingActivity.inputs.receivedDuringBasis, 18);
assert.equal(receivingActivity.consumptionRatePerDay, 1);

const missingInputs = calculateReorderForecast({
  ...baseEvidence,
  unit: null,
  unitCost: null,
  reorderPoint: null,
  targetLevel: null,
  samples: [sample(10, 0), sample(8, 0)],
});
assert.equal(missingInputs.status, "partial");
assert.equal("daysOfSupply" in missingInputs, false);
assert.equal("suggestedValue" in missingInputs, false);

console.log("reorder forecast cases passed: sparse, zero usage, receiving, normal demand, missing inputs");