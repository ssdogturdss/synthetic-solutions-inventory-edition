export type ForecastStatus = "calculated" | "partial" | "unavailable";

export type ForecastSample = {
  usage: number;
  received: number;
  basisDays: number;
  finalizedAt: string;
};

export type ReorderForecastEvidence = {
  productId: number;
  productName: string;
  unit: string | null;
  unitCost: number | null;
  reorderPoint: number | null;
  targetLevel: number | null;
  currentStock: number | null;
  samples: ForecastSample[];
  missingSnapshotCount?: number;
  receivingRecordCount?: number;
};

export type ReorderForecast = {
  productId: number;
  productName: string;
  status: ForecastStatus;
  statusReason: string;
  inputs: {
    verifiedSnapshotCount: number;
    basisDays: number;
    totalUsage: number;
    receivedDuringBasis: number;
    currentStock: number | null;
    unit: string | null;
    unitCost: number | null;
    reorderPoint: number | null;
    targetLevel: number | null;
    receivingRecordCount: number;
  };
  consumptionRatePerDay?: number;
  daysOfSupply?: number;
  daysUntilReorder?: number;
  suggestedQuantity?: number;
  suggestedValue?: number;
};

function finiteNonNegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Calculates a reorder signal from finalized usage snapshots. The caller is
 * responsible for supplying only snapshots from finalized sessions and a
 * measured time basis for each sample.
 */
export function calculateReorderForecast(
  evidence: ReorderForecastEvidence,
): ReorderForecast {
  const samples = evidence.samples.filter(
    (sample) =>
      Number.isFinite(sample.usage) &&
      sample.usage >= 0 &&
      Number.isFinite(sample.received) &&
      sample.received >= 0 &&
      Number.isFinite(sample.basisDays) &&
      sample.basisDays > 0 &&
      Boolean(sample.finalizedAt),
  );
  const totalUsage = samples.reduce((sum, sample) => sum + sample.usage, 0);
  const receivedDuringBasis = samples.reduce((sum, sample) => sum + sample.received, 0);
  const basisDays = samples.reduce((sum, sample) => sum + sample.basisDays, 0);
  const currentStock = finiteNonNegative(evidence.currentStock);
  const unitCost = finitePositive(evidence.unitCost);
  const reorderPoint = finiteNonNegative(evidence.reorderPoint);
  const targetLevel = finitePositive(evidence.targetLevel);
  const unit = evidence.unit?.trim() || null;
  const receivingRecordCount = evidence.receivingRecordCount ?? 0;
  const inputs = {
    verifiedSnapshotCount: samples.length,
    basisDays: round(basisDays),
    totalUsage: round(totalUsage),
    receivedDuringBasis: round(receivedDuringBasis),
    currentStock: currentStock == null ? null : round(currentStock),
    unit,
    unitCost: unitCost == null ? null : round(unitCost),
    reorderPoint: reorderPoint == null ? null : round(reorderPoint),
    targetLevel: targetLevel == null ? null : round(targetLevel),
    receivingRecordCount,
  };

  if (samples.length === 0 || basisDays <= 0) {
    return {
      productId: evidence.productId,
      productName: evidence.productName,
      status: "unavailable",
      statusReason: "No verified finalized usage snapshot has a usable time basis.",
      inputs,
    };
  }

  const consumptionRatePerDay = totalUsage / basisDays;
  if (!Number.isFinite(consumptionRatePerDay) || consumptionRatePerDay <= 0) {
    return {
      productId: evidence.productId,
      productName: evidence.productName,
      status: "unavailable",
      statusReason: "Verified snapshots show zero measured consumption, so reorder timing is unavailable.",
      inputs,
      consumptionRatePerDay: 0,
    };
  }

  const missingInputs =
    currentStock == null
      ? "current stock"
      : !unit
        ? "unit"
        : unitCost == null
          ? "unit cost"
          : reorderPoint == null
            ? "reorder point"
            : targetLevel == null
              ? "target level"
              : null;
  const expectedSamples = samples.length + (evidence.missingSnapshotCount ?? 0);
  const isPartial =
    Boolean(missingInputs) ||
    samples.length < 2 ||
    expectedSamples > samples.length;
  if (isPartial) {
    return {
      productId: evidence.productId,
      productName: evidence.productName,
      status: "partial",
      statusReason: missingInputs
        ? `Reorder timing is withheld because ${missingInputs} is missing or invalid.`
        : "The measured history is partial or has fewer than two verified snapshots.",
      inputs,
      consumptionRatePerDay: round(consumptionRatePerDay),
    };
  }

  const daysOfSupply = currentStock! / consumptionRatePerDay;
  const daysUntilReorder = Math.max(0, (currentStock! - reorderPoint!) / consumptionRatePerDay);
  const suggestedQuantity = Math.max(0, targetLevel! - currentStock!);

  return {
    productId: evidence.productId,
    productName: evidence.productName,
    status: "calculated",
    statusReason: "Calculated from verified finalized usage snapshots.",
    inputs,
    consumptionRatePerDay: round(consumptionRatePerDay),
    daysOfSupply: round(daysOfSupply),
    daysUntilReorder: round(daysUntilReorder),
    suggestedQuantity: round(suggestedQuantity),
    suggestedValue: round(suggestedQuantity * unitCost!),
  };
}