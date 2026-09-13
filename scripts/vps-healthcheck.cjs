"use strict";
fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + process.argv[2], {signal: AbortSignal.timeout(3000)})
  .then(async res => { if (!res.ok || (await res.json()).ok !== true) process.exit(1); })
  .catch(() => process.exit(1));
