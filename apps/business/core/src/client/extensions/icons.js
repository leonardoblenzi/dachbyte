import {
  FileCheck2,
  Glasses,
  Store,
  Wrench,
} from "lucide-react";

const extensionIconMap = Object.freeze({
  "file-check": FileCheck2,
  glasses: Glasses,
  store: Store,
  wrench: Wrench,
});

function extensionIcon(name, fallback = Wrench) {
  return extensionIconMap[String(name || "").trim()] || fallback;
}

export { extensionIcon };
