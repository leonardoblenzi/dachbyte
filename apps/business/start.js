"use strict";

// The Chat API is a separately deployed service. Business only proxies it via
// DACHBYTE_CHAT_API_URL and must never own a Python child process.
require("./server");
