"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSupportRequestEmail = void 0;
const emailTransportService_1 = require("./emailTransportService");
const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const resolveRecipients = () => {
    return [
        {
            email: 'contato@davanttisuite.com.br',
            name: 'Suporte Davantti Suite',
        },
    ];
};
const sendSupportRequestEmail = async (input) => {
    const recipients = resolveRecipients();
    if (recipients.length === 0) {
        throw new Error('Nenhum destinatario de suporte configurado.');
    }
    const subject = `[Suporte] ${input.subject} - ${input.requesterEmail}`;
    const requestedAt = new Date().toLocaleString('pt-BR');
    const responseLabel = input.responsePreference === 'phone' ? 'Celular' : 'Email';
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(subject)}</title>
      </head>
      <body style="margin:0;padding:28px 16px;background:#f5f5f7;font-family:Arial,sans-serif;color:#172033;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:880px;margin:0 auto;">
          <tr>
            <td>
              <div style="overflow:hidden;border-radius:28px;background:#ffffff;box-shadow:0 24px 80px rgba(15,23,42,0.12);">
                <div style="padding:28px 32px;background:linear-gradient(135deg,#ff5a36 0%,#ff944d 100%);color:#ffffff;">
                  <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,0.16);font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
                    Suporte Avantracking
                  </div>
                  <h1 style="margin:16px 0 0;font-size:30px;line-height:1.15;">Nova solicitacao de suporte</h1>
                  <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:rgba(255,255,255,0.92);">
                    Pedido enviado em ${escapeHtml(requestedAt)} com o contexto da conta anexado automaticamente.
                  </p>
                </div>

                <div style="display:grid;grid-template-columns:minmax(0,1.5fr) 320px;gap:16px;padding:16px;background:#f7f2ef;">
                  <div style="border:1px solid #f1d8cf;border-radius:24px;background:#ffffff;overflow:hidden;">
                    <div style="padding:22px 24px;border-bottom:1px solid #e5e7eb;">
                      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#f05a3d;">Mensagem</div>
                      <h2 style="margin:12px 0 0;font-size:20px;color:#172033;">${escapeHtml(input.subject)}</h2>
                    </div>

                    <div style="padding:22px 24px;">
                      <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Como responder</p>
                      <p style="margin:0 0 24px;font-size:15px;color:#172033;">${escapeHtml(responseLabel)}${input.phone ? ` - ${escapeHtml(input.phone)}` : ''}</p>

                      <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Mensagem do usuario</p>
                      <div style="border:1px solid #e5e7eb;border-radius:18px;background:#f8fafc;padding:18px 20px;font-size:15px;line-height:1.8;color:#172033;white-space:pre-wrap;">${escapeHtml(input.message)}</div>
                    </div>
                  </div>

                  <div style="display:flex;flex-direction:column;gap:16px;">
                    <div style="border:1px solid #f1d8cf;border-radius:24px;background:#ffffff;padding:20px;">
                      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#f05a3d;">Contexto</div>
                      ${[
        ['Email do login', input.requesterEmail],
        ['Nome', input.requesterName],
        ['Conta ativa', input.companyName || '-'],
        ['ID da conta', input.companyId || '-'],
        ['CNPJ', input.companyCnpj || '-'],
        ['Loja ativa', input.trayStoreName || input.trayStoreId || '-'],
        ['Tela atual', input.currentViewLabel || input.currentView],
    ]
        .map(([label, value]) => `
                            <div style="margin-top:12px;border:1px solid #e5e7eb;border-radius:18px;background:#f8fafc;padding:14px 16px;">
                              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">${escapeHtml(label)}</div>
                              <div style="margin-top:6px;font-size:14px;font-weight:700;color:#172033;">${escapeHtml(value)}</div>
                            </div>
                          `)
        .join('')}
                    </div>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
    const textContent = [
        'Nova solicitacao de suporte Avantracking',
        `Assunto: ${input.subject}`,
        `Enviado por: ${input.requesterName} <${input.requesterEmail}>`,
        `Preferencia de resposta: ${responseLabel}${input.phone ? ` - ${input.phone}` : ''}`,
        `Tela atual: ${input.currentViewLabel || input.currentView}`,
        `Conta ativa: ${input.companyName || '-'}`,
        `ID da conta: ${input.companyId || '-'}`,
        `CNPJ: ${input.companyCnpj || '-'}`,
        `Loja ativa: ${input.trayStoreName || input.trayStoreId || '-'}`,
        '',
        'Mensagem:',
        input.message,
    ].join('\n');
    await (0, emailTransportService_1.sendBrevoEmail)({
        to: recipients,
        subject,
        htmlContent,
        textContent,
    });
    return {
        recipients: recipients.length,
    };
};
exports.sendSupportRequestEmail = sendSupportRequestEmail;
