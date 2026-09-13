import { sendBrevoEmail } from './emailTransportService';

const APP_LOGO_URL =
  'https://res.cloudinary.com/dhqxp3tuo/image/upload/v1771249579/ChatGPT_Image_13_de_fev._de_2026_16_40_14_kldj3k.png';

type AccessEmailType = 'INVITE' | 'RESET_PASSWORD';

interface SendAccessEmailInput {
  toEmail: string;
  toName: string;
  accessType: AccessEmailType;
  actionUrl: string;
  expiresLabel: string;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getEmailCopy = (accessType: AccessEmailType) => {
  if (accessType === 'INVITE') {
    return {
      subject: 'Convite para acessar a plataforma Avantracking',
      title: 'Seu acesso esta pronto',
      intro:
        'Voce foi convidado(a) para acessar a plataforma Avantracking. Clique no botao abaixo para cadastrar sua senha e liberar seu acesso.',
      buttonLabel: 'Cadastrar senha',
      footer:
        'Se voce nao esperava este convite, apenas ignore esta mensagem.',
    };
  }

  return {
    subject: 'Redefinicao de senha - Avantracking',
    title: 'Redefina sua senha',
    intro:
      'Recebemos uma solicitacao para redefinir a senha da sua conta na plataforma Avantracking. Clique no botao abaixo para continuar.',
    buttonLabel: 'Redefinir senha',
    footer:
      'Se voce nao solicitou a redefinicao, ignore este e-mail. Sua senha atual continuara valida.',
  };
};

const buildAccessEmailHtml = ({
  toName,
  accessType,
  actionUrl,
  expiresLabel,
}: SendAccessEmailInput) => {
  const copy = getEmailCopy(accessType);

  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${copy.subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#0b1220;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="padding:32px 16px;background:radial-gradient(circle at top,#1d4ed8 0%,#0b1220 58%);">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;">
        <tr>
          <td style="padding:0;">
            <div style="background:#ffffff;border:1px solid #dbe4ff;border-radius:24px;overflow:hidden;box-shadow:0 22px 60px rgba(15,23,42,0.35);">
              <div style="padding:28px 32px 20px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%);text-align:center;">
                <img src="${APP_LOGO_URL}" alt="Avantracking" style="height:54px;display:inline-block;max-width:220px;" />
                <p style="margin:16px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#bfdbfe;">
                  Plataforma Avantracking
                </p>
              </div>

              <div style="padding:32px;">
                <p style="margin:0 0 8px;font-size:14px;color:#475569;">Ola, ${escapeHtml(toName)}.</p>
                <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#0f172a;">${copy.title}</h1>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#334155;">
                  ${copy.intro}
                </p>

                <div style="padding:18px 20px;border:1px solid #dbeafe;border-radius:18px;background:#eff6ff;margin-bottom:24px;">
                  <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#1d4ed8;font-weight:700;">
                    Validade do link
                  </p>
                  <p style="margin:0;font-size:15px;color:#1e293b;">
                    Este link expira em <strong>${escapeHtml(expiresLabel)}</strong>.
                  </p>
                </div>

                <div style="text-align:center;margin:30px 0;">
                  <a href="${actionUrl}" style="display:inline-block;padding:15px 28px;border-radius:999px;background:linear-gradient(135deg,#2563eb 0%,#0f172a 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">
                    ${copy.buttonLabel}
                  </a>
                </div>

                <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#475569;">
                  Caso o botao nao funcione, copie e cole este link no navegador:
                </p>
                <p style="margin:0;padding:14px 16px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;word-break:break-all;font-size:13px;line-height:1.6;color:#334155;">
                  ${escapeHtml(actionUrl)}
                </p>

                <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748b;">
                  ${copy.footer}
                </p>
              </div>
            </div>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>`;
};

export const sendAccessEmail = async (input: SendAccessEmailInput) => {
  const copy = getEmailCopy(input.accessType);
  const htmlContent = buildAccessEmailHtml(input);
  const textContent = [
    `Ola, ${input.toName}.`,
    copy.intro,
    `Acesse: ${input.actionUrl}`,
    `Validade: ${input.expiresLabel}.`,
    copy.footer,
  ].join('\n\n');

  await sendBrevoEmail({
    to: [
      {
        email: input.toEmail,
        name: input.toName,
      },
    ],
    subject: copy.subject,
    htmlContent,
    textContent,
  });
};
