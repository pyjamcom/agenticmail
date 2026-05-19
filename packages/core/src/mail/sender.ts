import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Transporter } from 'nodemailer';
import type { SendMailOptions, SendResult } from './types.js';

export interface MailSenderOptions {
  host: string;
  port: number;
  email: string;
  password: string;
  authUser?: string;
  secure?: boolean;
  tlsRejectUnauthorized?: boolean;
}

export interface SendResultWithRaw extends SendResult {
  /** Raw RFC822 message bytes (for appending to Sent folder) */
  raw: Buffer;
}

/** True for loopback hosts — the bundled local mail server lives here. */
export function isLoopbackMailHost(host: string | undefined): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost'
    || h === '::1'
    || h.endsWith('.localhost')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Resolve the effective TLS `rejectUnauthorized` for a mail connection.
 *
 * GHSA-wjjv-3mj2-39hf made certificate verification the default — but
 * the bundled local mail server (Stalwart on 127.0.0.1) presents a
 * self-signed certificate, so verifying it always fails and breaks
 * local agent-to-agent mail out of the box. A self-signed cert on a
 * loopback address is not a meaningful MITM surface, so for loopback
 * hosts verification defaults OFF. Remote hosts still verify by
 * default. An explicit `tlsRejectUnauthorized` option always wins
 * either way, so a deployment can still force-verify localhost or
 * opt a remote host out if it really needs to.
 */
export function resolveTlsRejectUnauthorized(
  host: string | undefined,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  return !isLoopbackMailHost(host);
}

export class MailSender {
  private transporter: Transporter;
  private email: string;

  constructor(private options: MailSenderOptions) {
    this.email = options.email;
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure ?? false,
      auth: {
        user: options.authUser ?? options.email,
        pass: options.password,
      },
      tls: {
        rejectUnauthorized: resolveTlsRejectUnauthorized(options.host, options.tlsRejectUnauthorized),
      },
      connectionTimeout: 10_000, // 10s to establish TCP connection
      greetingTimeout: 10_000,   // 10s for SMTP greeting
      socketTimeout: 15_000,     // 15s for any SMTP command response
    });
  }

  async send(mail: SendMailOptions): Promise<SendResultWithRaw> {
    const from = mail.fromName ? `${mail.fromName} <${this.email}>` : this.email;
    const mailOpts: any = {
      from,
      to: Array.isArray(mail.to) ? mail.to.join(', ') : mail.to,
      cc: mail.cc ? (Array.isArray(mail.cc) ? mail.cc.join(', ') : mail.cc) : undefined,
      bcc: mail.bcc ? (Array.isArray(mail.bcc) ? mail.bcc.join(', ') : mail.bcc) : undefined,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      replyTo: mail.replyTo,
      inReplyTo: mail.inReplyTo,
      references: Array.isArray(mail.references) ? mail.references.join(' ') : mail.references,
      headers: mail.headers,
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        encoding: a.encoding,
      })),
    };

    // Build raw RFC822 message (for Sent folder copy)
    const composer = new MailComposer(mailOpts);
    const raw = await composer.compile().build();

    // Retry transient SMTP failures (4xx) with exponential backoff
    const MAX_RETRIES = 2;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.transporter.sendMail(mailOpts);
        return {
          messageId: result.messageId,
          envelope: {
            from: result.envelope.from || '',
            to: Array.isArray(result.envelope.to) ? result.envelope.to : (result.envelope.to ? [result.envelope.to] : []),
          },
          raw,
        };
      } catch (err: any) {
        lastError = err;
        // Only retry on transient SMTP errors (4xx) or connection errors
        const code = err?.responseCode ?? err?.code;
        const isTransient = (typeof code === 'number' && code >= 400 && code < 500)
          || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ESOCKET';
        if (!isTransient || attempt === MAX_RETRIES) throw err;
        // Wait before retry: 1s, then 2s
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw lastError!;
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.transporter.close();
  }
}
