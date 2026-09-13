import { Request, Response } from 'express';
import { sendSupportRequestEmail } from '../services/supportRequestService';

export const sendSupportRequest = async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Usuario nao autenticado.' });
  }

  const subject = String(req.body?.subject || '').trim();
  const responsePreference =
    req.body?.responsePreference === 'phone' ? 'phone' : 'email';
  const phone = String(req.body?.phone || '').trim();
  const message = String(req.body?.message || '').trim();
  const currentView = String(req.body?.currentView || '').trim();
  const currentViewLabel = String(req.body?.currentViewLabel || '').trim();
  const companyName = String(req.body?.companyName || '').trim();
  const companyId = String(req.body?.companyId || '').trim();
  const companyCnpj = String(req.body?.companyCnpj || '').trim();
  const trayStoreName = String(req.body?.trayStoreName || '').trim();
  const trayStoreId = String(req.body?.trayStoreId || '').trim();
  const userName = String(req.body?.userName || req.user.email || '').trim();

  if (!subject) {
    return res.status(400).json({ error: 'Informe o assunto da solicitacao.' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Informe a mensagem da solicitacao.' });
  }

  if (responsePreference === 'phone' && !phone) {
    return res
      .status(400)
      .json({ error: 'Informe um celular para retorno.' });
  }

  try {
    const result = await sendSupportRequestEmail({
      requesterEmail: req.user.email,
      requesterName: userName || req.user.email,
      subject,
      responsePreference,
      phone: phone || null,
      message,
      currentView,
      currentViewLabel: currentViewLabel || currentView,
      companyName: companyName || null,
      companyId: companyId || req.user.companyId || null,
      companyCnpj: companyCnpj || null,
      trayStoreName: trayStoreName || null,
      trayStoreId: trayStoreId || null,
    });

    return res.json({
      success: true,
      message: `Solicitacao enviada com sucesso para ${result.recipients} destinatario(s).`,
    });
  } catch (error) {
    console.error('Erro ao enviar solicitacao de suporte:', error);
    return res
      .status(500)
      .json({ error: 'Nao foi possivel enviar a solicitacao de suporte.' });
  }
};
