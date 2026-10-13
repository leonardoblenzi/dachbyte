export async function fetchAllPages(fetchPage, query = {}, collectionKey) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  let expectedTotal = null;
  do {
    const payload = await fetchPage({ ...query, page, pageSize: 100 });
    const batch = payload?.data?.[collectionKey];
    if (!Array.isArray(batch) || !payload?.pagination) {
      throw new Error("Nao foi possivel confirmar a integridade da exportacao.");
    }
    rows.push(...batch);
    totalPages = Number(payload.pagination.totalPages);
    if (page === 1 && Number.isSafeInteger(Number(payload.pagination.total))) expectedTotal = Number(payload.pagination.total);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1 || Number(payload.pagination.page) !== page) {
      throw new Error("A paginacao da exportacao retornou dados invalidos.");
    }
    page += 1;
  } while (page <= totalPages);
  if (expectedTotal !== null && rows.length !== expectedTotal) {
    throw new Error("Os dados mudaram durante a exportacao. Tente novamente.");
  }
  return rows;
}
