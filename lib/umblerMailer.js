"use strict";

const net = require("net");
const tls = require("tls");

function normalize(value) {
  return String(value || "").trim();
}

function smtpConfig() {
  const host = normalize(process.env.UMBLER_SMTP_HOST || process.env.SMTP_HOST || process.env.MAIL_HOST);
  const port = Number(process.env.UMBLER_SMTP_PORT || process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
  const user = normalize(process.env.UMBLER_SMTP_USER || process.env.SMTP_USER || process.env.SMTP_USERNAME);
  const pass = normalize(process.env.UMBLER_SMTP_PASSWORD || process.env.SMTP_PASSWORD || process.env.MAIL_PASSWORD);
  const fromEmail = normalize(
    process.env.UMBLER_SMTP_FROM ||
      process.env.SMTP_FROM ||
      process.env.MAIL_FROM ||
      user,
  );
  const fromName = normalize(
    process.env.UMBLER_SMTP_FROM_NAME ||
      process.env.SMTP_FROM_NAME ||
      process.env.MAIL_FROM_NAME ||
      "Suporte DACHBYTE",
  );
  const secure = String(process.env.UMBLER_SMTP_SECURE || process.env.SMTP_SECURE || "")
    .trim()
    .toLowerCase() === "true" || port === 465;

  return { host, port, user, pass, fromEmail, fromName, secure };
}

function isConfigured() {
  const config = smtpConfig();
  return Boolean(config.host && config.port && config.user && config.pass && config.fromEmail);
}

function encodeHeader(value) {
  const text = normalize(value);
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function address(name, email) {
  const safeEmail = normalize(email);
  const safeName = normalize(name);
  if (!safeName) return `<${safeEmail}>`;
  return `"${safeName.replaceAll('"', "'")}" <${safeEmail}>`;
}

function dotStuff(value) {
  return String(value || "").replace(/^\./gm, "..");
}

function createMessage({ fromName, fromEmail, toName, toEmail, subject, html, text }) {
  const boundary = `davantti-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return [
    `From: ${address(fromName, fromEmail)}`,
    `To: ${address(toName, toEmail)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    "X-Mailer: DACHBYTE SAC Umbler SMTP",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text || "",
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html || "",
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const options = {
      host: config.host,
      port: config.port,
      servername: config.host,
      timeout: 15000,
    };
    const socket = config.secure
      ? tls.connect(options, () => resolve(socket))
      : net.createConnection(options, () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("Timeout na conexao SMTP.")));
  });
}

function smtpSession(socket) {
  let buffer = "";
  const waiters = [];

  function pump() {
    while (waiters.length) {
      const waiter = waiters[0];
      const lines = buffer.split(/\r?\n/);
      let consumed = 0;
      let complete = false;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) continue;
        consumed = index + 1;
        if (/^\d{3} /.test(line)) {
          complete = true;
          break;
        }
      }
      if (!complete) return;
      const rawLines = lines.slice(0, consumed);
      buffer = lines.slice(consumed).join("\r\n");
      waiters.shift();
      const last = rawLines[rawLines.length - 1] || "";
      const code = Number(last.slice(0, 3));
      waiter.resolve({ code, raw: rawLines.join("\n") });
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    pump();
  });

  function readResponse() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      pump();
      setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new Error("Timeout aguardando resposta SMTP."));
        }
      }, 15000);
    });
  }

  async function command(line, expectedCodes) {
    socket.write(`${line}\r\n`);
    const response = await readResponse();
    const expected = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    if (!expected.includes(response.code)) {
      throw new Error(`SMTP respondeu ${response.code} para ${line}: ${response.raw}`);
    }
    return response;
  }

  return { readResponse, command };
}

async function sendUmblerEmail({ toEmail, toName, subject, html, text }) {
  const config = smtpConfig();
  if (!isConfigured()) {
    return {
      sent: false,
      skipped: true,
      reason: "SMTP/Umbler nao configurado.",
    };
  }

  let socket = await connect(config);
  let session = smtpSession(socket);

  try {
    const greeting = await session.readResponse();
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting inesperado: ${greeting.raw}`);
    }

    await session.command(`EHLO ${config.host}`, 250);

    if (!config.secure) {
      await session.command("STARTTLS", 220);
      socket = await new Promise((resolve, reject) => {
        const secureSocket = tls.connect({
          socket,
          servername: config.host,
        }, () => resolve(secureSocket));
        secureSocket.once("error", reject);
      });
      session = smtpSession(socket);
      await session.command(`EHLO ${config.host}`, 250);
    }

    await session.command("AUTH LOGIN", 334);
    await session.command(Buffer.from(config.user, "utf8").toString("base64"), 334);
    await session.command(Buffer.from(config.pass, "utf8").toString("base64"), 235);
    await session.command(`MAIL FROM:<${config.fromEmail}>`, 250);
    await session.command(`RCPT TO:<${normalize(toEmail)}>`, [250, 251]);
    await session.command("DATA", 354);

    const message = createMessage({
      fromName: config.fromName,
      fromEmail: config.fromEmail,
      toName,
      toEmail,
      subject,
      html,
      text,
    });
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    const dataResponse = await session.readResponse();
    if (dataResponse.code !== 250) {
      throw new Error(`SMTP recusou DATA: ${dataResponse.raw}`);
    }
    await session.command("QUIT", 221).catch(() => null);

    return {
      sent: true,
      skipped: false,
      provider: "umbler-smtp",
      response: dataResponse.raw,
    };
  } finally {
    socket.end();
  }
}

module.exports = {
  isConfigured,
  sendUmblerEmail,
};
