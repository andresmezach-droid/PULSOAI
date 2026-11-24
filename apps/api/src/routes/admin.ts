import { Response, Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import {
  requireSuperAdmin,
  SuperAdminRequest,
} from '../middleware/superAdmin';
import {
  ClinicRow,
  ClinicSpecialty,
  WeeklyBusinessHours,
} from '../types/database';
import { encrypt } from '../utils/crypto';

export const adminRouter = Router();

// Todas las rutas de /api/admin requieren pertenecer a platform_admins
adminRouter.use(requireSuperAdmin);

const DEFAULT_ONBOARD_BUSINESS_HOURS: WeeklyBusinessHours = {
  monday: { enabled: true, start: '08:00', end: '17:00' },
  tuesday: { enabled: true, start: '08:00', end: '17:00' },
  wednesday: { enabled: true, start: '08:00', end: '17:00' },
  thursday: { enabled: true, start: '08:00', end: '17:00' },
  friday: { enabled: true, start: '08:00', end: '17:00' },
  saturday: { enabled: true, start: '08:00', end: '13:00' },
  sunday: { enabled: false, start: '09:00', end: '13:00' },
};

const onboardClinicBodySchema = z.object({
  name: z.string().trim().min(2, 'El nombre de la clínica es obligatorio'),
  specialty: z
    .enum(['odontologia', 'medicina_estetica', 'ambas'])
    .default('odontologia'),
  whatsapp_phone_id: z
    .string()
    .trim()
    .min(3, 'El whatsapp_phone_id de Meta es obligatorio'),
  whatsapp_access_token: z
    .string()
    .trim()
    .min(5, 'El whatsapp_access_token es obligatorio'),
  whatsapp_display_phone: z.string().trim().optional(),
  admin_email: z.string().trim().email('Debe ser un email válido'),
  admin_password: z
    .string()
    .min(8, 'La contraseña temporal debe tener al menos 8 caracteres'),
  admin_full_name: z.string().trim().optional(),
  business_hours: z
    .record(
      z.object({
        enabled: z.boolean(),
        start: z.string(),
        end: z.string(),
      })
    )
    .optional(),
});

const toggleStatusBodySchema = z.object({
  is_active: z.boolean(),
});

const clinicIdParamSchema = z.object({
  id: z.string().uuid('El ID de la clínica debe ser un UUID válido'),
});

function buildSlugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const randomSuffix = Math.random().toString(36).slice(2, 6);
  return `${base || 'clinica'}-${randomSuffix}`;
}

/**
 * GET /api/admin/clinics
 * Lista todas las clínicas registradas en la plataforma con su estado (is_active),
 * fecha de creación, total de citas del mes actual y cantidad total de conversaciones.
 */
adminRouter.get(
  '/clinics',
  async (_req: SuperAdminRequest, res: Response): Promise<void> => {
    try {
      const { data: clinics, error: clinicsErr } = await supabaseAdmin
        .from('clinics')
        .select(
          'id, name, slug, specialty, whatsapp_phone_id, whatsapp_display_phone, is_active, created_at'
        )
        .order('created_at', { ascending: false })
        .returns<
          Array<
            Pick<
              ClinicRow,
              | 'id'
              | 'name'
              | 'slug'
              | 'specialty'
              | 'whatsapp_phone_id'
              | 'whatsapp_display_phone'
              | 'is_active'
              | 'created_at'
            >
          >
        >();

      if (clinicsErr) {
        res.status(500).json({
          error: `Error consultando clínicas: ${clinicsErr.message}`,
        });
        return;
      }

      // Inicio del mes actual en UTC
      const now = new Date();
      const monthStartIso = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)
      ).toISOString();

      const [apptsRes, convsRes] = await Promise.all([
        supabaseAdmin
          .from('appointments')
          .select('id, clinic_id')
          .gte('created_at', monthStartIso)
          .returns<Array<{ id: string; clinic_id: string }>>(),
        supabaseAdmin
          .from('conversations')
          .select('id, clinic_id')
          .returns<Array<{ id: string; clinic_id: string }>>(),
      ]);

      const monthlyApptsByClinic = new Map<string, number>();
      for (const appt of apptsRes.data ?? []) {
        monthlyApptsByClinic.set(
          appt.clinic_id,
          (monthlyApptsByClinic.get(appt.clinic_id) ?? 0) + 1
        );
      }

      const convsByClinic = new Map<string, number>();
      for (const conv of convsRes.data ?? []) {
        convsByClinic.set(
          conv.clinic_id,
          (convsByClinic.get(conv.clinic_id) ?? 0) + 1
        );
      }

      const enrichedClinics = (clinics ?? []).map((c) => ({
        ...c,
        monthly_appointments_count: monthlyApptsByClinic.get(c.id) ?? 0,
        conversations_count: convsByClinic.get(c.id) ?? 0,
      }));

      res.status(200).json({
        clinics: enrichedClinics,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error listando clínicas';
      res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/admin/clinics/onboard
 * Onboarding rápido de una nueva clínica en una sola operación:
 * 1. Inserta el registro en `clinics` cifrando `whatsapp_access_token` con AES-256-GCM (`encrypt()`).
 * 2. Inserta `business_hours` por defecto (Lunes a Viernes 08:00-17:00, Sábado 08:00-13:00).
 * 3. Crea el usuario administrador en Supabase Auth (`supabaseAdmin.auth.admin.createUser`)
 *    y lo vincula en `clinic_users` con rol `admin`.
 */
adminRouter.post(
  '/clinics/onboard',
  async (req: SuperAdminRequest, res: Response): Promise<void> => {
    const parsedBody = onboardClinicBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: 'Datos de onboarding inválidos',
        details: parsedBody.error.flatten(),
      });
      return;
    }

    const {
      name,
      specialty,
      whatsapp_phone_id,
      whatsapp_access_token,
      whatsapp_display_phone,
      admin_email,
      admin_password,
      admin_full_name,
      business_hours,
    } = parsedBody.data;

    try {
      const encryptedToken = encrypt(whatsapp_access_token);
      const slug = buildSlugFromName(name);
      const effectiveBusinessHours =
        (business_hours as WeeklyBusinessHours | undefined) ??
        DEFAULT_ONBOARD_BUSINESS_HOURS;

      // 1. Insertar la clínica en `clinics`
      const { data: createdClinic, error: clinicInsertErr } =
        await supabaseAdmin
          .from('clinics')
          .insert({
            name,
            slug,
            specialty: specialty as ClinicSpecialty,
            whatsapp_phone_id,
            whatsapp_access_token: encryptedToken,
            whatsapp_display_phone: whatsapp_display_phone || null,
            timezone: 'America/Caracas',
            currency_mode: 'USD_BCV',
            business_hours: effectiveBusinessHours,
            payment_methods: [
              'Pago Móvil (Tasa BCV)',
              'Zelle',
              'Efectivo USD',
              'Punto de Venta',
            ],
            is_active: true,
          })
          .select('*')
          .single<ClinicRow>();

      if (clinicInsertErr || !createdClinic) {
        res.status(400).json({
          error: `No se pudo crear la clínica (verifica que whatsapp_phone_id no esté duplicado): ${
            clinicInsertErr?.message ?? 'Error desconocido'
          }`,
        });
        return;
      }

      // 2. Crear (o recuperar si ya existía) el usuario administrador en Supabase Auth
      let targetUserId: string | null = null;

      const { data: createdAuthUser, error: createAuthErr } =
        await supabaseAdmin.auth.admin.createUser({
          email: admin_email,
          password: admin_password,
          email_confirm: true,
        });

      if (createAuthErr || !createdAuthUser.user) {
        // Si el usuario ya existe en Supabase Auth, intentamos buscarlo en la lista de usuarios
        const { data: usersList } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = usersList?.users.find(
          (u) => u.email?.toLowerCase() === admin_email.toLowerCase()
        );

        if (!existingUser) {
          // Rollback de la clínica recién creada para mantener consistencia
          await supabaseAdmin
            .from('clinics')
            .delete()
            .eq('id', createdClinic.id);

          res.status(400).json({
            error: `No se pudo crear el usuario en Supabase Auth: ${
              createAuthErr?.message ?? 'Error desconocido'
            }`,
          });
          return;
        }

        targetUserId = existingUser.id;
      } else {
        targetUserId = createdAuthUser.user.id;
      }

      // 3. Vincular el usuario en `clinic_users` con rol `admin`
      const { error: memberErr } = await supabaseAdmin
        .from('clinic_users')
        .upsert(
          {
            clinic_id: createdClinic.id,
            user_id: targetUserId,
            role: 'admin',
            full_name: admin_full_name || `Admin ${name}`,
            is_active: true,
          },
          { onConflict: 'clinic_id,user_id' }
        );

      if (memberErr) {
        res.status(500).json({
          error: `Clínica y usuario creados, pero falló la vinculación en clinic_users: ${memberErr.message}`,
        });
        return;
      }

      res.status(201).json({
        message: 'Clínica y usuario administrador creados exitosamente.',
        clinic: {
          ...createdClinic,
          monthly_appointments_count: 0,
          conversations_count: 0,
        },
        admin_user: {
          id: targetUserId,
          email: admin_email,
          role: 'admin',
        },
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Error inesperado durante el onboarding de la clínica';
      console.error('[AdminRoute POST /clinics/onboard Error]:', message);
      res.status(500).json({ error: message });
    }
  }
);

/**
 * PATCH /api/admin/clinics/:id/status
 * Activa o suspende una clínica (`is_active: boolean`) para control de pagos mensuales (MRR).
 * Cuando `is_active === false`, el webhook ignora silenciosamente los mensajes entrantes de esa clínica.
 */
adminRouter.patch(
  '/clinics/:id/status',
  async (req: SuperAdminRequest, res: Response): Promise<void> => {
    const parsedParams = clinicIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: 'ID de clínica inválido',
        details: parsedParams.error.flatten(),
      });
      return;
    }

    const parsedBody = toggleStatusBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: 'Debe enviar { "is_active": boolean }',
        details: parsedBody.error.flatten(),
      });
      return;
    }

    const { id } = parsedParams.data;
    const { is_active } = parsedBody.data;

    const { data: updatedClinic, error } = await supabaseAdmin
      .from('clinics')
      .update({ is_active })
      .eq('id', id)
      .select(
        'id, name, slug, specialty, whatsapp_phone_id, whatsapp_display_phone, is_active, created_at'
      )
      .maybeSingle<
        Pick<
          ClinicRow,
          | 'id'
          | 'name'
          | 'slug'
          | 'specialty'
          | 'whatsapp_phone_id'
          | 'whatsapp_display_phone'
          | 'is_active'
          | 'created_at'
        >
      >();

    if (error) {
      res.status(500).json({
        error: `Error actualizando estado de la clínica: ${error.message}`,
      });
      return;
    }

    if (!updatedClinic) {
      res.status(404).json({ error: 'Clínica no encontrada.' });
      return;
    }

    res.status(200).json({
      clinic: updatedClinic,
    });
  }
);
