/**
 * Reusable server-side pagination for Drizzle ORM + PostgreSQL
 * Usage in routes:
 *   const result = await paginate({
 *     db,
 *     schema: schema.contacts,
 *     req,
 *     where: eq(schema.contacts.userId, userId),
 *     searchableColumns: ['name', 'phone', 'email'],
 *     defaultSort: { column: schema.contacts.createdAt, dir: 'desc' }
 *   });
 *   res.render('page', { ...result });
 */
import { sql, ilike, desc, asc, and } from "drizzle-orm";

export async function paginate(options) {
  const {
    db,
    schema,
    req,
    where = null,
    searchableColumns = [],
    defaultSort = null,
    baseColumns = null,
    extraParams = {},
  } = options;

  // Parse query params
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = parseInt(req.query.perPage) || 10;
  const perPageOptions = [10, 30, 50];
  const limit = perPageOptions.includes(perPage) ? perPage : 10;

  // Parse column-specific search filters
  const columnFilters = {};
  for (const col of searchableColumns) {
    let val = req.query[`search_${col}`] || "";
    // Handle case where duplicate inputs send an array
    if (Array.isArray(val)) {
      val = val.find(v => v && String(v).trim()) || "";
    }
    val = String(val);
    if (val.trim()) columnFilters[col] = val.trim();
  }

  // Parse sorting
  const sortCol = req.query.sort || (defaultSort ? "createdAt" : "");
  const sortDir = req.query.dir || "desc";

  // Build WHERE with search filters
  let conditions = [];
  if (where) conditions.push(where);

  for (const [col, val] of Object.entries(columnFilters)) {
    const tableCol = schema[col];
    if (tableCol) {
      // Cast to text so ILIKE works on timestamps, numbers, etc.
      conditions.push(sql`${tableCol}::text ILIKE ${`%${val}%`}`);
    }
  }

  // Count total (for pagination)
  let countQuery;
  if (conditions.length === 0) {
    countQuery = db.select({ count: sql`count(*)::int` }).from(schema);
  } else if (conditions.length === 1) {
    countQuery = db.select({ count: sql`count(*)::int` }).from(schema).where(conditions[0]);
  } else {
    countQuery = db.select({ count: sql`count(*)::int` }).from(schema).where(and(...conditions));
  }
  const totalResult = await countQuery;
  const total = totalResult[0]?.count || 0;

  // Build data query with sorting
  let sortColumn = defaultSort ? schema[sortCol] || defaultSort.column : schema[sortCol];
  if (!sortColumn && defaultSort) sortColumn = defaultSort.column;
  if (!sortColumn) sortColumn = schema.id;

  const orderFn = sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  let dataQuery;
  const columnsToSelect = baseColumns || schema;

  if (conditions.length === 0) {
    dataQuery = db.select().from(schema).orderBy(orderFn).limit(limit).offset((page - 1) * limit);
  } else if (conditions.length === 1) {
    dataQuery = db.select().from(schema).where(conditions[0]).orderBy(orderFn).limit(limit).offset((page - 1) * limit);
  } else {
    dataQuery = db.select().from(schema).where(and(...conditions)).orderBy(orderFn).limit(limit).offset((page - 1) * limit);
  }

  const data = await dataQuery;

  // Calculate pagination values
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);

  // Build page range (show up to 5 pages)
  let startPage = Math.max(1, safePage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) {
    startPage = Math.max(1, endPage - 4);
  }
  const pageRange = [];
  for (let i = startPage; i <= endPage; i++) pageRange.push(i);

  // Build query string (preserve filters in pagination links)
  const queryParams = new URLSearchParams();
  for (const [col, val] of Object.entries(columnFilters)) {
    queryParams.set(`search_${col}`, val);
  }
  for (const [key, val] of Object.entries(extraParams)) {
    if (val !== undefined && val !== null && val !== "") {
      queryParams.set(key, String(val));
    }
  }
  if (sortCol) queryParams.set("sort", sortCol);
  if (sortDir) queryParams.set("dir", sortDir);
  if (perPage !== 10) queryParams.set("perPage", String(perPage));
  const baseQuery = queryParams.toString();

  return {
    data,
    pagination: {
      page: safePage,
      perPage: limit,
      total,
      totalPages,
      pageRange,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      startPage,
      endPage,
      baseQuery,
    },
    columnFilters,
    sortCol,
    sortDir,
    searchableColumns,
  };
}
