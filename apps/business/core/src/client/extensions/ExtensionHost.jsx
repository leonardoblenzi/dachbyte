import React, { useEffect, useState } from "react";
import { loadExtensionPageComponent, loadExtensionSlotComponent } from "./registry";

function AsyncExtensionHost({ loader, componentProps = {}, fallback = null }) {
  const [Component, setComponent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setComponent(null);
    setError(null);
    Promise.resolve()
      .then(loader)
      .then((resolved) => {
        if (!active) return;
        setComponent(() => resolved || null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError);
      });
    return () => { active = false; };
  }, [loader]);

  if (error) {
    return (
      <div className="panel panel-section">
        <strong>Extensao indisponivel</strong>
        <p>{error.message || "Nao foi possivel carregar este recurso."}</p>
      </div>
    );
  }
  if (!Component) return fallback || <div className="panel panel-section">Carregando extensao...</div>;
  return <Component {...componentProps} />;
}

function ExtensionPageHost({ pageId, configuration, componentProps = {}, fallback = null }) {
  const loader = React.useCallback(
    () => loadExtensionPageComponent(pageId, configuration),
    [pageId, configuration],
  );
  return <AsyncExtensionHost loader={loader} componentProps={componentProps} fallback={fallback} />;
}

function ExtensionSlotHost({ extensionKey, slot, contributionId, configuration, componentProps = {}, fallback = null }) {
  const loader = React.useCallback(
    () => loadExtensionSlotComponent(extensionKey, slot, contributionId, configuration),
    [extensionKey, slot, contributionId, configuration],
  );
  return <AsyncExtensionHost loader={loader} componentProps={componentProps} fallback={fallback} />;
}

export { ExtensionPageHost, ExtensionSlotHost };
