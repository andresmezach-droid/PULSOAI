import { Response, Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { AuthenticatedRequest, requireClinicAuth } from '../middleware/auth';
import { getBcvRate } from '../services/bcv';
import { AppointmentStatus } from '../types/database';

export const analyticsRouter = Router();

// Todas las rutas de /api/analytics requieren JWT válido de clínica
analyticsRouter.use(requireClinicAuth);

const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

interface AppointmentMetricRow {
  id: string;
  status: AppointmentStatus;
  price_usd: number | null;
  created_at: string;
  starts_at: string;
  services: {
    price_usd: number;
  } | null;
}

export interface DailyAppointmentPoint {
  date: string; // YYYY-MM-DD en America/Caracas
  count: number;
}

/**
 * GET /api/analytics/summary?days=30
 * Calcula y devuelve las métricas de ROI para el `clinicId` autenticado:
 * - total_conversations
 * - ai_messages_sent
 * - appointments_booked (total y desglose por estado)
 * - leads_followed_up
 * - estimated_revenue_usd (suma de price_usd en citas confirmed + completed)
 * - estimated_revenue_bs (equivalente a tasa BCV vigente)
 * - daily_appointments (serie de los últimos 14 días en America/Caracas)
 */
analyticsRouter.get(
  '/summary',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const parsedQuery = summaryQuerySchema.safeParse(req.query);
    const days = parsedQuery.success ? parsedQuery.data.days : 30;
    const { clinicId } = auth;

    const nowMs = Date.now();
    const periodStartIso = new Date(
      nowMs - days * 24 * 60 * 60 * 1000
    ).toISOString();

    try {
      const [
        convCountRes,
        aiMsgCountRes,
        followupsCountRes,
        appointmentsRes,
        bcvRes,
      ] = await Promise.all([
        // 1. Conversaciones activas en el período
        supabaseAdmin
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('clinic_id', clinicId)
          .gte('last_message_at', periodStartIso),

        // 2. Total de mensajes respondidos automáticamente por la IA en el período
        supabaseAdmin
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('clinic_id', clinicId)
          .eq('sender_type', 'ai')
          .gte('created_at', periodStartIso),

        // 3. Conversaciones con followup_24h_sent = true en el período
        supabaseAdmin
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('clinic_id', clinicId)
          .eq('followup_24h_sent', true)
          .gte('updated_at', periodStartIso),

        // 4. Citas creadas en el período con su servicio vinculado
        supabaseAdmin
          .from('appointments')
          .select(
            `
            id,
            status,
            price_usd,
            created_at,
            starts_at,
            services ( price_usd )
          `
          )
          .eq('clinic_id', clinicId)
          .gte('created_at', periodStartIso)
          .returns<AppointmentMetricRow[]>(),

        // 5. Tasa BCV vigente
        getBcvRate().catch(() => ({
          rate: 1,
          updatedAt: new Date().toISOString(),
          source: 'fallback' as const,
        })),
      ]);

      const appointments = appointmentsRes.data ?? [];

      let confirmedCount = 0;
      let completedCount = 0;
      let cancelledCount = 0;
      let noShowCount = 0;
      let estimatedRevenueUsd = 0;

      for (const appt of appointments) {
        if (appt.status === 'confirmed' || appt.status === 'scheduled') {
          confirmedCount += 1;
        } else if (appt.status === 'completed') {
          completedCount += 1;
        } else if (appt.status === 'cancelled') {
          cancelledCount += 1;
        } else if (appt.status === 'no_show') {
          noShowCount += 1;
        }

        if (
          appt.status === 'confirmed' ||
          appt.status === 'scheduled' ||
          appt.status === 'completed'
        ) {
          const itemPrice =
            appt.price_usd !== null && appt.price_usd !== undefined
              ? Number(appt.price_usd)
              : Number(appt.services?.price_usd ?? 0);
          estimatedRevenueUsd += Number.isNaN(itemPrice) ? 0 : itemPrice;
        }
      }

      const roundedUsd = Number(estimatedRevenueUsd.toFixed(2));
      const estimatedRevenueBs = Number(
        (roundedUsd * bcvRes.rate).toFixed(2)
      );

      // Serie diaria de los últimos 14 días en zona horaria America/Caracas (UTC-4)
      const fourteenDaysStartIso = new Date(
        nowMs - 14 * 24 * 60 * 60 * 1000
      ).toISOString();

      const { data: recent14dAppointments } = await supabaseAdmin
        .from('appointments')
        .select('id, created_at')
        .eq('clinic_id', clinicId)
        .gte('created_at', fourteenDaysStartIso)
        .returns<Array<{ id: string; created_at: string }>>();

      const countsByCaracasDate = new Map<string, number>();
      for (let i = 13; i >= 0; i--) {
        const dayCaracasMs =
          nowMs - i * 24 * 60 * 60 * 1000 - 4 * 60 * 60 * 1000;
        const ymd = new Date(dayCaracasMs).toISOString().slice(0, 10);
        countsByCaracasDate.set(ymd, 0);
      }

      for (const item of recent14dAppointments ?? []) {
        const caracasMs =
          new Date(item.created_at).getTime() - 4 * 60 * 60 * 1000;
        const ymd = new Date(caracasMs).toISOString().slice(0, 10);
        if (countsByCaracasDate.has(ymd)) {
          countsByCaracasDate.set(ymd, (countsByCaracasDate.get(ymd) ?? 0) + 1);
        }
      }

      const dailyAppointments: DailyAppointmentPoint[] = Array.from(
        countsByCaracasDate.entries()
      ).map(([date, count]) => ({
        date,
        count,
      }));

      res.status(200).json({
        period_days: days,
        bcv_rate: bcvRes.rate,
        total_conversations: convCountRes.count ?? 0,
        ai_messages_sent: aiMsgCountRes.count ?? 0,
        appointments_booked: {
          total: appointments.length,
          confirmed: confirmedCount,
          completed: completedCount,
          cancelled: cancelledCount,
          no_show: noShowCount,
        },
        leads_followed_up: followupsCountRes.count ?? 0,
        estimated_revenue_usd: roundedUsd,
        estimated_revenue_bs: estimatedRevenueBs,
        daily_appointments: dailyAppointments,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error calculando métricas de ROI';
      console.error('[AnalyticsRoute GET /summary Error]:', message);
      res.status(500).json({ error: message });
    }
  }
);
