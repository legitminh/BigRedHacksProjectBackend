import { appendFile, mkdir } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";

export type LoginCodeMessage = {
  to: string;
  code: string;
  expiresIn: number;
};

export type Mailer = {
  sendLoginCode(message: LoginCodeMessage): Promise<void>;
};

type SmtpSettings = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

type Conn = Socket | TLSSocket;

export function createMailer(config: Config, outboxPath = resolve("data/outbox.jsonl")): Mailer {
  const smtp = smtpSettings(config);
  if (smtp) return createSmtpMailer(smtp);
  // The file outbox writes login codes to disk in plaintext — dev only. In production
  // without SMTP, refuse rather than silently "sending" codes nobody receives (or
  // leaving them readable on disk).
  if (config.production) return createRefusingMailer();
  return createOutboxMailer(outboxPath);
}

export function createRefusingMailer(): Mailer {
  return {
    async sendLoginCode() {
      throw new HttpError(
        503,
        "email_not_configured",
        "Email sign-in is unavailable.",
      );
    },
  };
}

function smtpSettings(config: Config): SmtpSettings | null {
  if (
    !config.smtpHost ||
    config.smtpPort === null ||
    !config.smtpUser ||
    !config.smtpPass ||
    !config.mailFrom
  ) {
    return null;
  }
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    user: config.smtpUser,
    pass: config.smtpPass,
    from: config.mailFrom,
  };
}

export function createOutboxMailer(path: string): Mailer {
  return {
    async sendLoginCode(message) {
      await mkdir(dirname(path), { recursive: true });
      const line = JSON.stringify({
        to: message.to,
        code: message.code,
        expires_in: message.expiresIn,
        created_at: new Date().toISOString(),
      });
      await appendFile(path, `${line}\n`, "utf8");
    },
  };
}

function createSmtpMailer(settings: SmtpSettings): Mailer {
  return {
    async sendLoginCode(message) {
      const minutes = Math.max(1, Math.round(message.expiresIn / 60));
      await sendSmtp(settings, {
        to: message.to,
        subject: "Your Waypoint sign-in code",
        text: `Your Waypoint sign-in code is ${message.code}.\n\nIt expires in ${minutes} minutes. If you did not try to sign in, you can ignore this email.\n`,
      });
    },
  };
}

function addrSpec(value: string): string {
  const wrapped = /<([^<>\s]+)>/.exec(value);
  return (wrapped?.[1] ?? value).trim();
}

async function sendSmtp(
  settings: SmtpSettings,
  message: { to: string; subject: string; text: string },
): Promise<void> {
  const implicitTls = settings.port === 465;
  let socket: Conn = await openSocket(settings.host, settings.port, implicitTls);
  socket.setTimeout(20_000);
  try {
    await expectCode(socket, [220]);
    await command(socket, "EHLO waypoint.local", [250]);
    if (!implicitTls) {
      await command(socket, "STARTTLS", [220]);
      socket = await startTls(socket as Socket, settings.host);
      socket.setTimeout(20_000);
      await command(socket, "EHLO waypoint.local", [250]);
    }
    await command(socket, "AUTH LOGIN", [334]);
    await command(socket, Buffer.from(settings.user, "utf8").toString("base64"), [334]);
    await command(socket, Buffer.from(settings.pass, "utf8").toString("base64"), [235]);
    await command(socket, `MAIL FROM:<${addrSpec(settings.from)}>`, [250]);
    await command(socket, `RCPT TO:<${message.to}>`, [250, 251]);
    await command(socket, "DATA", [354]);
    const pending = readReply(socket);
    await writeRaw(socket, dataPayload(settings.from, message));
    const code = await pending;
    if (code !== 250) throw new Error(`SMTP ${code}`);
    await command(socket, "QUIT", [221]);
  } finally {
    socket.end();
  }
}

function dataPayload(from: string, message: { to: string; subject: string; text: string }): string {
  const text = message.text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    ".",
    "",
  ].join("\r\n");
}

function openSocket(host: string, port: number, tls: boolean): Promise<Conn> {
  return new Promise((resolveSocket, reject) => {
    const socket = tls
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    const onError = (error: Error) => {
      socket.off("connect", onReady);
      socket.off("secureConnect", onReady);
      reject(error);
    };
    const onReady = () => {
      socket.off("error", onError);
      resolveSocket(socket);
    };
    socket.once("error", onError);
    if (tls) socket.once("secureConnect", onReady);
    else socket.once("connect", onReady);
  });
}

function startTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolveSocket, reject) => {
    const tls = tlsConnect({ socket, servername: host }, () => resolveSocket(tls));
    tls.once("error", reject);
  });
}

async function command(socket: Conn, line: string, ok: number[]): Promise<void> {
  const pending = readReply(socket);
  await writeLine(socket, line);
  const code = await pending;
  if (!ok.includes(code)) throw new Error(`SMTP ${code}`);
}

async function expectCode(socket: Conn, ok: number[]): Promise<void> {
  const code = await readReply(socket);
  if (!ok.includes(code)) throw new Error(`SMTP ${code}`);
}

function readReply(socket: Conn): Promise<number> {
  return new Promise((resolveCode, reject) => {
    let buffer = "";
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("SMTP timed out"));
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!buffer.endsWith("\r\n")) return;
      const lines = buffer.slice(0, -2).split("\r\n");
      const last = lines[lines.length - 1] ?? "";
      const match = /^(\d{3}) /.exec(last);
      if (!match) return;
      cleanup();
      resolveCode(Number(match[1]));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
  });
}

function writeLine(socket: Conn, line: string): Promise<void> {
  return writeRaw(socket, `${line}\r\n`);
}

function writeRaw(socket: Conn, payload: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    socket.write(payload, "utf8", (error) => (error ? reject(error) : resolveWrite()));
  });
}
