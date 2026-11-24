import { Request, Response, Router } from 'express';
import { getBcvRate } from '../services/bcv';

export const bcvRouter = Router();

/**
 * GET /api/bcv
 * Devuelve la tasa oficial BCV actual (desde caché Redis o API externa/fallback)
 * para mostrarla en la barra superior del Dashboard.
 */
bcvRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const bcv = await getBcvRate();
    res.status(200).json(bcv);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error consultando tasa BCV';
    res.status(503).json({ error: message });
  }
});
