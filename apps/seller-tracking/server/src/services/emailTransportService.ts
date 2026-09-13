import { dbQuery } from '../lib/db';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

export interface BrevoRecipient {
  email: string;
  name?: string;
}

interface SendBrevoEmailInput {
  to: BrevoRecipient[];
  subject: string;
  htmlContent: string;
  textContent: string;
}

export const sendBrevoEmail = async (input: SendBrevoEmailInput) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail =
    process.env.BREVO_SENDER_EMAIL || process.env.BREVO_SENDER_MAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Avantracking';

  if (!apiKey || !senderEmail) {
    throw new Error(
      'Configuracao de e-mail incompleta. Defina BREVO_API_KEY e BREVO_SENDER_EMAIL ou BREVO_SENDER_MAIL.',
    );
  }

  if (!Array.isArray(input.to) || input.to.length === 0) {
    throw new Error('Nenhum destinatario informado para o envio do e-mail.');
  }

  const normalizedRecipients = input.to
    .map((recipient) => ({
      ...recipient,
      email: String(recipient.email || '').trim(),
    }))
    .filter((recipient) => Boolean(recipient.email));

  if (normalizedRecipients.length === 0) {
    throw new Error('Nenhum destinatario valido informado para o envio do e-mail.');
  }

  const uniqueLowercaseEmails = Array.from(
    new Set(
      normalizedRecipients.map((recipient) => recipient.email.toLowerCase()),
    ),
  );

  const usersWithPreferenceResult = await dbQuery<{
    email: string;
    receivePlatformEmails: boolean | null;
  }>(
    `
      SELECT "email", "receivePlatformEmails"
      FROM "User"
      WHERE LOWER("email") = ANY($1::text[])
    `,
    [uniqueLowercaseEmails],
  );
  const usersWithPreference = usersWithPreferenceResult.rows;

  const preferenceByEmail = new Map<string, boolean>(
    usersWithPreference.map((user: { email: string; receivePlatformEmails: boolean }) => [
      String(user.email || '').toLowerCase(),
      user.receivePlatformEmails !== false,
    ]),
  );

  const allowedRecipients = normalizedRecipients.filter((recipient) => {
    const preference = preferenceByEmail.get(recipient.email.toLowerCase());
    return preference !== false;
  });

  if (allowedRecipients.length === 0) {
    console.log(
      'Envio de e-mail ignorado: todos os destinatarios internos desativaram o recebimento de e-mails da plataforma.',
    );
    return;
  }

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: {
        email: senderEmail,
        name: senderName,
      },
      to: allowedRecipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name || recipient.email,
      })),
      subject: input.subject,
      htmlContent: input.htmlContent,
      textContent: input.textContent,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Brevo respondeu com erro ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
    );
  }
};
