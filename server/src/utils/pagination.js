// ISSUES #21 — Pagination for every list endpoint.
//
// Backwards compatible by design: `data` is still the plain array the existing
// frontend expects, with pagination metadata alongside it under `meta`.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parses `?page=&limit=` into Prisma `skip`/`take`.
 * `?limit=all` (or `limit=0`) disables paging for exports and small reference lists.
 */
export function getPagination(query) {
  const rawLimit = query?.limit;

  if (rawLimit === "all" || rawLimit === "0" || rawLimit === 0) {
    return { skip: undefined, take: undefined, page: 1, limit: null, unpaged: true };
  }

  const page = Math.max(1, Number.parseInt(query?.page, 10) || 1);
  const parsedLimit = Number.parseInt(rawLimit, 10);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT)
  );

  return { skip: (page - 1) * limit, take: limit, page, limit, unpaged: false };
}

/** Uniform paginated envelope. */
export function paginated(res, rows, total, pagination, extra = {}) {
  return res.status(200).json({
    success: true,
    data: rows,
    meta: {
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: pagination.limit ? Math.max(1, Math.ceil(total / pagination.limit)) : 1,
      hasMore: pagination.limit ? pagination.page * pagination.limit < total : false,
    },
    ...extra,
  });
}

export default { getPagination, paginated };
