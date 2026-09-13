import { sendBrevoEmail, BrevoRecipient } from './emailTransportService';

const APP_LOGO_URL =
  'https://res.cloudinary.com/dhqxp3tuo/image/upload/v1771249579/ChatGPT_Image_13_de_fev._de_2026_16_40_14_kldj3k.png';

interface ReleaseNotesEmailInput {
  version: string;
  title: string;
  summary: string;
  newFeatures: string[];
  adjustments: string[];
  recipients: BrevoRecipient[];
}

interface ReleaseNotesTemplateInput {
  version: string;
  title: string;
  summary: string;
  newFeatures: string[];
  adjustments: string[];
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildListMarkup = (items: string[], emptyLabel: string) => {
  if (items.length === 0) {
    return `<p style="margin:0;color:#64748b;font-size:14px;">${escapeHtml(emptyLabel)}</p>`;
  }

  return `
    <ul style="margin:0;padding-left:20px;color:#0f172a;font-size:14px;line-height:1.7;">
      ${items
        .map((item) => `<li style="margin-bottom:8px;">${escapeHtml(item)}</li>`)
        .join('')}
    </ul>
  `;
};

export const buildReleaseNotesHtml = (input: ReleaseNotesTemplateInput) => `
  <!DOCTYPE html>
  <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(input.title)}</title>
    </head>
    <body style="margin:0;padding:32px 16px;background:#e2e8f0;font-family:Arial,sans-serif;color:#0f172a;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;margin:0 auto;">
        <tr>
          <td>
            <div style="border-radius:28px;overflow:hidden;background:#0f172a;box-shadow:0 24px 80px rgba(15,23,42,0.28);">
              <div style="padding:28px 32px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%);">
                <div style="text-align:right;margin-bottom:12px;">
                  <img src="${APP_LOGO_URL}" alt="Avantracking" style="width:112px;max-width:112px;height:auto;display:inline-block;" />
                </div>
                <div style="display:inline-block;padding:8px 16px;border-radius:999px;background:rgba(255,255,255,0.14);color:#dbeafe;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                  Release Notes ${escapeHtml(input.version)}
                </div>
                <h1 style="margin:18px 0 0;font-size:30px;line-height:1.2;color:#ffffff;">${escapeHtml(input.title)}</h1>
              </div>

              <div style="padding:32px;background:#ffffff;">
                <div style="padding:22px;border-radius:22px;background:#f8fafc;border:1px solid #e2e8f0;">
                  <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#2563eb;">Resumo da versao</div>
                  <p style="margin:12px 0 0;font-size:15px;line-height:1.7;color:#0f172a;">${escapeHtml(input.summary)}</p>
                </div>

                <div style="display:grid;gap:18px;margin-top:24px;">
                  <div style="padding:22px;border-radius:22px;background:#eff6ff;border:1px solid #bfdbfe;">
                    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#1d4ed8;">Novas funcionalidades</div>
                    <div style="margin-top:14px;">
                      ${buildListMarkup(input.newFeatures, 'Nenhuma funcionalidade nova informada nesta versao.')}
                    </div>
                  </div>

                  <div style="padding:22px;border-radius:22px;background:#f8fafc;border:1px solid #e2e8f0;">
                    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0f172a;">Ajustes e melhorias</div>
                    <div style="margin-top:14px;">
                      ${buildListMarkup(input.adjustments, 'Nenhum ajuste adicional informado nesta versao.')}
                    </div>
                  </div>
                </div>

                <div style="margin-top:28px;padding:18px 20px;border-radius:18px;background:#0f172a;color:#cbd5e1;font-size:13px;line-height:1.7;">
                  Este comunicado foi enviado pelo time Avantracking para informar a nova versao da plataforma.
                </div>
              </div>
            </div>
          </td>
        </tr>
      </table>
    </body>
  </html>
`;

export const buildReleaseNotesText = (input: ReleaseNotesTemplateInput) =>
  [
    `${input.title} - versao ${input.version}`,
    '',
    input.summary,
    '',
    'Novas funcionalidades:',
    ...(input.newFeatures.length > 0
      ? input.newFeatures.map((item) => `- ${item}`)
      : ['- Nenhuma funcionalidade nova informada nesta versao.']),
    '',
    'Ajustes e melhorias:',
    ...(input.adjustments.length > 0
      ? input.adjustments.map((item) => `- ${item}`)
      : ['- Nenhum ajuste adicional informado nesta versao.']),
  ].join('\n');

export const sendReleaseNotesEmail = async (input: ReleaseNotesEmailInput) => {
  const payload = {
    version: input.version,
    title: input.title,
    summary: input.summary,
    newFeatures: input.newFeatures,
    adjustments: input.adjustments,
  };

  await sendBrevoEmail({
    to: input.recipients,
    subject: `${input.title} - versao ${input.version}`,
    htmlContent: buildReleaseNotesHtml(payload),
    textContent: buildReleaseNotesText(payload),
  });
};
