import { Request, Response } from 'express';
import { notificationService } from '../services/notificationService';

const parseStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : [];

const parseWatchEvents = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => String(item || '').trim().toUpperCase())
        .filter(Boolean)
    : [];

export const getNotificationFeed = async (req: Request, res: Response) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const feed = await notificationService.getFeed(companyId);
    return res.json({
      success: true,
      ...feed,
    });
  } catch (error) {
    console.error('Erro ao carregar notificacoes:', error);
    return res.status(500).json({ error: 'Erro ao carregar notificacoes' });
  }
};

export const listMonitoredOrders = async (req: Request, res: Response) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const monitoredOrderIds = await notificationService.getMonitoredOrderIds(companyId);
    return res.json({
      success: true,
      monitoredOrderIds,
    });
  } catch (error) {
    console.error('Erro ao listar pedidos monitorados:', error);
    return res.status(500).json({ error: 'Erro ao listar pedidos monitorados' });
  }
};

export const addMonitoredOrders = async (req: Request, res: Response) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const orderIds = parseStringArray(req.body?.orderIds);
    const identifiers = parseStringArray(req.body?.identifiers);
    const watchEvents = parseWatchEvents(req.body?.watchEvents);

    if (orderIds.length === 0 && identifiers.length === 0) {
      return res.status(400).json({
        error: 'Informe orderIds ou identifiers para incluir nos monitorados.',
      });
    }

    const result = await notificationService.addMonitoredOrders({
      companyId,
      createdById: req.user?.id || null,
      orderIds,
      identifiers,
      watchEvents,
    });

    const addedCount = result.addedOrders.length;
    const alreadyCount = result.alreadyMonitoredOrders.length;
    const limitExceededCount = Array.isArray(result.limitExceededOrders)
      ? result.limitExceededOrders.length
      : 0;
    const maxMonitoredOrders = Number(result.maxMonitoredOrders || 10);

    return res.json({
      success: true,
      message:
        addedCount > 0
          ? limitExceededCount > 0
            ? `${addedCount} pedido(s) incluido(s). Limite de ${maxMonitoredOrders} monitorados atingido para esta empresa.`
            : `${addedCount} pedido(s) incluido(s) nos monitorados.`
          : alreadyCount > 0
            ? 'Os pedidos informados ja estavam monitorados.'
            : limitExceededCount > 0
              ? `Limite de ${maxMonitoredOrders} pedidos monitorados por empresa atingido.`
            : 'Nenhum pedido valido foi encontrado para monitorar.',
      ...result,
    });
  } catch (error) {
    console.error('Erro ao incluir pedidos monitorados:', error);
    return res.status(500).json({ error: 'Erro ao incluir pedidos monitorados' });
  }
};

export const removeMonitoredOrder = async (req: Request, res: Response) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const orderId = String(req.params?.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'Informe o orderId para remover.' });
    }

    const monitoredOrderIds = await notificationService.removeMonitoredOrder(
      companyId,
      orderId,
    );

    return res.json({
      success: true,
      message: 'Pedido removido dos monitorados.',
      monitoredOrderIds,
    });
  } catch (error) {
    console.error('Erro ao remover pedido monitorado:', error);
    return res.status(500).json({ error: 'Erro ao remover pedido monitorado' });
  }
};

export const markAllNotificationsAsRead = async (req: Request, res: Response) => {
  try {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
    }

    const result = await notificationService.markAllAsRead(companyId);

    return res.json({
      success: true,
      message: 'Todas as notificacoes foram marcadas como lidas.',
      ...result,
    });
  } catch (error) {
    console.error('Erro ao marcar notificacoes como lidas:', error);
    return res
      .status(500)
      .json({ error: 'Erro ao marcar notificacoes como lidas' });
  }
};
