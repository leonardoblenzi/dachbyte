import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

function defaultSearchText(item) {
  if (!item) return "";
  if (typeof item === "string" || typeof item === "number") return String(item);
  return Object.values(item).join(" ");
}

function OperationalList({
  actions,
  columns,
  emptyDescription = "Ajuste a busca, mude os filtros ou cadastre um novo item.",
  emptyTitle = "Nenhum item encontrado",
  filter,
  filters = [],
  getItemKey,
  initialFilter,
  initialSearch = "",
  items,
  renderRow,
  searchPlaceholder,
  searchText = defaultSearchText,
  serverLoading = false,
  serverPagination = null,
  onServerQueryChange = null,
}) {
  const serverMode = Boolean(onServerQueryChange && serverPagination);
  const [search, setSearch] = useState(initialSearch || "");
  const defaultFilter = filters.some((item) => item.value === initialFilter) ? initialFilter : filters[0]?.value || "Todos";
  const [activeFilter, setActiveFilter] = useState(defaultFilter);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(serverPagination?.pageSize || 10);
  const lastServerQuery = useRef("");
  const onServerQueryChangeRef = useRef(onServerQueryChange);

  useEffect(() => {
    onServerQueryChangeRef.current = onServerQueryChange;
  }, [onServerQueryChange]);

  useEffect(() => {
    if (!initialFilter || !filters.some((item) => item.value === initialFilter)) return;
    setActiveFilter(initialFilter);
    setPage(1);
  }, [initialFilter]);

  useEffect(() => {
    if (initialSearch === undefined || initialSearch === null) return;
    setSearch(String(initialSearch));
    setPage(1);
  }, [initialSearch]);

  const filteredItems = useMemo(() => {
    if (serverMode) return items;
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filter && !filter(item, activeFilter)) return false;
      if (!term) return true;
      return searchText(item).toLowerCase().includes(term);
    });
  }, [activeFilter, filter, items, search, searchText, serverMode]);

  const clientTotalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const totalPages = serverMode ? Math.max(1, Number(serverPagination?.totalPages || 1)) : clientTotalPages;
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleItems = serverMode
    ? filteredItems
    : filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);
  const totalItems = serverMode ? Number(serverPagination?.total || 0) : filteredItems.length;
  const effectivePageSize = serverMode ? Number(serverPagination?.pageSize || pageSize) : pageSize;

  useEffect(() => {
    if (serverMode) return;
    setPage(1);
  }, [search, activeFilter, pageSize, items.length, serverMode]);

  useEffect(() => {
    if (!serverMode) return undefined;
    const query = { search, filter: activeFilter, page, pageSize };
    const signature = JSON.stringify(query);
    if (signature === lastServerQuery.current) return undefined;
    const timer = window.setTimeout(() => {
      lastServerQuery.current = signature;
      onServerQueryChangeRef.current?.(query);
    }, search ? 280 : 0);
    return () => window.clearTimeout(timer);
  }, [activeFilter, page, pageSize, search, serverMode]);

  useEffect(() => {
    if (!serverMode) return;
    if (page > totalPages) setPage(totalPages);
  }, [page, serverMode, totalPages]);

  function updateSearch(value) {
    setSearch(value);
    setPage(1);
  }

  function updateFilter(value) {
    setActiveFilter(value);
    setPage(1);
  }

  function updatePageSize(value) {
    setPageSize(value);
    setPage(1);
  }

  const startItem = totalItems ? (safePage - 1) * effectivePageSize + 1 : 0;
  const endItem = totalItems ? Math.min((safePage - 1) * effectivePageSize + visibleItems.length, totalItems) : 0;

  return (
    <>
      {actions ? <div className="operational-list-actions">{actions}</div> : null}
      <div className="operational-list-filters">
        <label className="search-box">
          <Search size={18} />
          <input value={search} placeholder={searchPlaceholder} onChange={(event) => updateSearch(event.target.value)} />
        </label>
        {filters.length ? (
          <div className="operational-list-chips" aria-label="Filtros da lista">
            {filters.map((item) => (
              <button
                className={activeFilter === item.value ? "active" : ""}
                key={item.value}
                type="button"
                onClick={() => updateFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="operational-list-head">
        <span>{serverLoading ? "Carregando..." : `${totalItems} ${totalItems === 1 ? "item encontrado" : "itens encontrados"}`}</span>
        <label>
          Exibir
          <select value={pageSize} onChange={(event) => updatePageSize(Number(event.target.value))}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>
      <div className="table-wrap operational-list-wrap" aria-busy={serverLoading ? "true" : "false"}>
        <table className="operational-list-table">
          <thead>
            <tr>
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item, index) => renderRow(item, {
              index,
              key: getItemKey ? getItemKey(item) : index,
            }))}
            {!visibleItems.length ? (
              <tr>
                <td colSpan={columns.length}>
                  <div className="empty-state compact">
                    <Search size={28} />
                    <strong>{serverLoading ? "Carregando dados" : emptyTitle}</strong>
                    <span>{serverLoading ? "Consultando o servidor..." : emptyDescription}</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        <span>{totalItems ? `Mostrando ${startItem}-${endItem} de ${totalItems}` : "Nenhum item para exibir"}</span>
        <div className="pager">
          <button className="button-secondary" type="button" disabled={safePage <= 1 || serverLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Anterior</button>
          <strong>{safePage} / {totalPages}</strong>
          <button className="button-secondary" type="button" disabled={safePage >= totalPages || serverLoading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Proxima</button>
        </div>
      </div>
    </>
  );
}

export { OperationalList };
