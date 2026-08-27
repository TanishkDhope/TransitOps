// ISSUES #33 — Trip revenue used to be a free-text number typed at completion,
// so every ROI figure rested on whatever someone happened to enter. Revenue is
// now computed from the customer's rate card and may be overridden with a reason.

/** Prisma Decimal | string | number → number. */
const num = (value) => (value == null ? null : Number(value));

/**
 * Computes expected revenue for a trip from its customer's rate card.
 *
 * Precedence: flatRate wins; otherwise distance and tonne-km components are summed.
 * Returns null when the customer has no usable rate card, so the caller can fall
 * back to a manually entered figure.
 */
export function computeRevenue({ customer, distanceKm, cargoWeightKg }) {
  if (!customer) return null;

  const flatRate = num(customer.flatRate);
  if (flatRate != null && flatRate > 0) {
    return Number(flatRate.toFixed(2));
  }

  const ratePerKm = num(customer.ratePerKm) ?? 0;
  const ratePerTonneKm = num(customer.ratePerTonneKm) ?? 0;

  if (ratePerKm === 0 && ratePerTonneKm === 0) return null;

  const distance = Number(distanceKm) || 0;
  const tonnes = (Number(cargoWeightKg) || 0) / 1000;

  const total = ratePerKm * distance + ratePerTonneKm * distance * tonnes;
  return Number(total.toFixed(2));
}

/** Explains how a computed figure was derived, for display next to the amount. */
export function explainRevenue({ customer, distanceKm, cargoWeightKg }) {
  if (!customer) return null;

  const flatRate = num(customer.flatRate);
  if (flatRate != null && flatRate > 0) {
    return `Flat rate for ${customer.name}`;
  }

  const parts = [];
  const ratePerKm = num(customer.ratePerKm) ?? 0;
  const ratePerTonneKm = num(customer.ratePerTonneKm) ?? 0;

  if (ratePerKm > 0) parts.push(`₹${ratePerKm}/km × ${distanceKm} km`);
  if (ratePerTonneKm > 0) {
    const tonnes = ((Number(cargoWeightKg) || 0) / 1000).toFixed(2);
    parts.push(`₹${ratePerTonneKm}/tonne-km × ${distanceKm} km × ${tonnes} t`);
  }

  return parts.length > 0 ? parts.join(" + ") : null;
}

export default { computeRevenue, explainRevenue };
